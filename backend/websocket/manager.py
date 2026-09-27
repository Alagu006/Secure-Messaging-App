"""
manager.py — WebSocket connection manager for real-time chat.

This file runs while the server is running and keeps track of who is
online. Every message event comes in through a WebSocket, the server
processes it (saves to DB, looks up recipients), then broadcasts the
result to the right people.

KEY RULE: The server NEVER looks at message content. All ciphertext
is forwarded as-is. The server only reads metadata (sender, recipient,
message_id) to know where to route things.
"""

import os
from datetime import datetime, timedelta

from fastapi import WebSocket
# Security fix: Replace python-jose with PyJWT to avoid vulnerable non-constant-time ecdsa (PYSEC-2026-1325).
import jwt
from jwt.exceptions import PyJWTError as JWTError
import database

# ── JWT config (same secret key used by auth.py) ──────────────────────────
# Security fix: Read SECRET_KEY with no default and fail loudly at startup if unset.
SECRET_KEY = os.getenv("SECRET_KEY")
if not SECRET_KEY:
    raise RuntimeError("SECRET_KEY environment variable is not set")
ALGORITHM = "HS256"


def _verify_token(token: str) -> dict | None:
    """Decode and verify a JWT.

    Returns the payload (user_id, username) if valid, or None if
    the token is expired, malformed, or signed with the wrong key.
    """
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload
    except JWTError:
        return None


# ── Connection manager (tracks every online user) ─────────────────────────

class ConnectionManager:
    """Keeps a dict of {user_id: WebSocket} so we can send messages to
    specific users or broadcast to everyone at once."""

    def __init__(self):
        # Maps user_id (UUID string) → active WebSocket connection
        self.active_connections: dict[str, WebSocket] = {}

    # ── Core connect / disconnect ──────────────────────────────────────────

    async def connect(self, websocket: WebSocket, user_id: str):
        """Accept a WebSocket and add user to the online list."""
        await websocket.accept()
        self.active_connections[user_id] = websocket

        # Tell everyone else that this user came online
        await self.broadcast({
            "event": "user_online",
            "data": {"user_id": user_id},
        })

        # Tell this user about all currently online users
        online_ids = [uid for uid in self.active_connections if uid != user_id]
        if online_ids:
            await self.send_personal(user_id, {
                "event": "online_users",
                "data": {"users": online_ids},
            })

    async def disconnect(self, user_id: str):
        """Remove user from the online list and update DB."""
        if user_id in self.active_connections:
            del self.active_connections[user_id]

            # Record when they went offline
            async with database.pool.acquire() as conn:
                await conn.execute(
                    "UPDATE users SET last_seen = now() WHERE id = $1",
                    user_id,
                )

            # Tell everyone else that this user went offline
            await self.broadcast({
                "event": "user_offline",
                "data": {"user_id": user_id},
            })

    # ── Sending helpers ────────────────────────────────────────────────────

    async def send_personal(self, user_id: str, message: dict):
        """Send a JSON message to a single user (if they are online)."""
        ws = self.active_connections.get(user_id)
        if ws is None:
            return  # user is offline, drop silently

        try:
            await ws.send_json(message)
        except Exception:
            # Connection probably died — remove it
            await self.disconnect(user_id)

    async def broadcast(self, message: dict):
        """Send a JSON message to every connected user."""
        # Snapshot the list so we don't mutate while iterating
        for user_id in list(self.active_connections.keys()):
            await self.send_personal(user_id, message)

    async def broadcast_to_users(self, user_ids: list[str], message: dict):
        """Send a JSON message to a specific list of users."""
        for uid in user_ids:
            await self.send_personal(uid, message)

    async def disconnect_all(self):
        """Gracefully disconnect every connected user.

        Called during server shutdown. Sends a 'server_shutdown' event
        so clients can show a message, then closes each WebSocket.
        """
        for user_id in list(self.active_connections.keys()):
            try:
                await self.send_personal(user_id, {
                    "event": "server_shutdown",
                    "data": {"message": "Server is shutting down"},
                })
                ws = self.active_connections.get(user_id)
                if ws:
                    await ws.close(code=1001, reason="Server shutdown")
            except Exception as e:
                # Security fix: Log cleanup error instead of silently discarding it.
                print(f"[cleanup] ignored error: {e}")
        self.active_connections.clear()

    async def _get_conversation_users(self, sender_id: str, data: dict) -> list[str]:
        """Given the incoming send_message data, return all user IDs that
        should receive the outgoing event.

        For DMs: sender + recipient
        For groups: sender + all group members
        """
        group_id = data.get("group_id")
        recipient_id = data.get("recipient_id")

        if group_id:
            # Group chat — fetch all members from DB
            async with database.pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT user_id FROM group_members WHERE group_id = $1::uuid",
                    group_id,
                )
            user_ids = [str(r["user_id"]) for r in rows]
            if recipient_id and recipient_id not in user_ids:
                user_ids.append(recipient_id)
            return user_ids
        else:
            # Direct message — sender + recipient
            users = {sender_id}
            if recipient_id:
                users.add(recipient_id)
            return list(users)

    async def _get_message_participants(self, message_id: str) -> list[str]:
        """Look up a message in the DB and return all user IDs that are
        part of that conversation (used for reaction / edit / delete broadcasts)."""
        async with database.pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT sender_id, recipient_id, group_id FROM messages WHERE id = $1::uuid",
                message_id,
            )
        if row is None:
            return []

        sender_id = str(row["sender_id"])
        group_id = row["group_id"]
        recipient_id = row["recipient_id"]

        if group_id:
            async with database.pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT user_id FROM group_members WHERE group_id = $1::uuid",
                    group_id,
                )
            user_ids = [str(r["user_id"]) for r in rows]
            return list(set(user_ids + [sender_id]))

        users = {sender_id}
        if recipient_id:
            users.add(str(recipient_id))
        return list(users)

    # ── Event handlers ─────────────────────────────────────────────────────

    async def handle_send_message(self, sender_id: str, data: dict):
        """Save a new encrypted message to the DB and forward it to
        everyone in the conversation.

        The ciphertext is never decrypted — the server is a dumb router.
        """
        recipient_id = data.get("recipient_id")
        group_id = data.get("group_id")
        ciphertext = data.get("ciphertext", "")
        message_type = data.get("message_type", "text")
        reply_to_id = data.get("reply_to_id")

        if not ciphertext:
            return  # nothing to send

        # Feature: Compute expiration timestamp if TTL is specified
        ttl_seconds = data.get("ttl_seconds")
        expires_at = None
        if ttl_seconds and isinstance(ttl_seconds, (int, float)) and ttl_seconds > 0:
            expires_at = datetime.utcnow() + timedelta(seconds=int(ttl_seconds))

        # Insert the message into the database
        async with database.pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO messages (sender_id, recipient_id, group_id,
                                      ciphertext, message_type, reply_to_id, expires_at)
                VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7)
                RETURNING id, created_at, expires_at
                """,
                sender_id,
                recipient_id,
                group_id,
                ciphertext,
                message_type,
                reply_to_id,
                expires_at,
            )

        message_id = str(row["id"])
        created_at = row["created_at"].isoformat() if row["created_at"] else None
        expires_at_iso = row["expires_at"].isoformat() if row["expires_at"] else None

        # Determine if recipient is online
        recipient_online = recipient_id and recipient_id in self.active_connections

        # Insert initial message_status rows for tracking
        # Sender always gets 'sent'; recipient gets 'delivered' if online, else 'sent'
        async with database.pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO message_status (message_id, user_id, status)
                VALUES ($1::uuid, $2::uuid, 'sent')
                ON CONFLICT (message_id, user_id) DO NOTHING
                """,
                message_id,
                sender_id,
            )
            if recipient_id:
                recipient_status = 'delivered' if recipient_online else 'sent'
                await conn.execute(
                    """
                    INSERT INTO message_status (message_id, user_id, status)
                    VALUES ($1::uuid, $2::uuid, $3)
                    ON CONFLICT (message_id, user_id) DO UPDATE SET status = $3, updated_at = now()
                    """,
                    message_id,
                    recipient_id,
                    recipient_status,
                )

        # Build the outgoing event
        outgoing = {
            "event": "new_message",
            "data": {
                "id": message_id,
                "sender_id": sender_id,
                "recipient_id": recipient_id,
                "group_id": group_id,
                "ciphertext": ciphertext,
                "message_type": message_type,
                "reply_to_id": reply_to_id,
                "created_at": created_at,
                "expires_at": expires_at_iso,
            },
        }

        # Send to everyone in the conversation
        targets = await self._get_conversation_users(sender_id, data)
        await self.broadcast_to_users(targets, outgoing)

        # Send delivery receipt to sender if recipient is online
        if recipient_online:
            await self.send_personal(sender_id, {
                "event": "delivery_receipt",
                "data": {
                    "message_id": message_id,
                    "delivered_to": recipient_id,
                },
            })

    async def handle_typing_start(self, sender_id: str, data: dict):
        """Tell the recipient (or group) that sender is typing."""
        await self._broadcast_typing(sender_id, data, is_typing=True)

    async def handle_typing_stop(self, sender_id: str, data: dict):
        """Tell the recipient (or group) that sender stopped typing."""
        await self._broadcast_typing(sender_id, data, is_typing=False)

    async def _broadcast_typing(self, sender_id: str, data: dict, is_typing: bool):
        """Shared helper for typing_start / typing_stop."""
        recipient_id = data.get("recipient_id")
        group_id = data.get("group_id")

        # Determine who should receive this typing indicator
        if group_id:
            async with database.pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT user_id FROM group_members WHERE group_id = $1::uuid",
                    group_id,
                )
            targets = [str(r["user_id"]) for r in rows if str(r["user_id"]) != sender_id]
        elif recipient_id:
            targets = [recipient_id]
        else:
            return  # nowhere to send

        await self.broadcast_to_users(targets, {
            "event": "typing_indicator",
            "data": {
                "user_id": sender_id,
                "recipient_id": recipient_id,
                "group_id": group_id,
                "is_typing": is_typing,
            },
        })

    async def handle_message_read(self, reader_id: str, data: dict):
        """Mark a message as read and notify the original sender.

        The client sends a read receipt when the user opens/conversation
        or views the message. The sender sees a "double tick" indicator.
        """
        message_id = data.get("message_id")
        other_user_id = data.get("other_user_id")

        if not message_id or not other_user_id:
            return

        # Security fix: Verify caller is a conversation participant before marking message as read.
        participants = await self._get_message_participants(message_id)
        if reader_id not in participants:
            return await self.send_personal(reader_id, {
                "event": "error", "data": {"message": "Unauthorized: Not a conversation participant"},
            })

        # Update message_status to 'read'
        async with database.pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO message_status (message_id, user_id, status)
                VALUES ($1::uuid, $2::uuid, 'read')
                ON CONFLICT (message_id, user_id) DO UPDATE SET status = 'read', updated_at = now()
                """,
                message_id,
                reader_id,
            )

        # Notify the other user (the original sender)
        await self.send_personal(other_user_id, {
            "event": "read_receipt",
            "data": {
                "message_id": message_id,
                "read_by": reader_id,
            },
        })

    async def handle_message_reaction(self, user_id: str, data: dict):
        """Save an emoji reaction and broadcast it to the conversation."""
        message_id = data.get("message_id")
        emoji = data.get("emoji")

        if not message_id or not emoji:
            return

        # Security fix: Verify caller is a conversation participant before processing reactions.
        targets = await self._get_message_participants(message_id)
        if user_id not in targets:
            return await self.send_personal(user_id, {
                "event": "error", "data": {"message": "Unauthorized: Not a conversation participant"},
            })

        # Save to the reactions table (deduplicate by message_id + user_id + emoji)
        async with database.pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO reactions (message_id, user_id, emoji)
                VALUES ($1::uuid, $2::uuid, $3)
                ON CONFLICT (message_id, user_id, emoji) DO NOTHING
                RETURNING id, created_at
                """,
                message_id,
                user_id,
                emoji,
            )

        # Send the update to all conversation participants
        targets = await self._get_message_participants(message_id)
        await self.broadcast_to_users(targets, {
            "event": "reaction_update",
            "data": {
                "id": str(row["id"]),
                "message_id": message_id,
                "user_id": user_id,
                "emoji": emoji,
                "created_at": row["created_at"].isoformat() if row["created_at"] else None,
            },
        })

    async def handle_message_edit(self, user_id: str, data: dict):
        """Update the ciphertext of an existing message.

        Only the original sender should be able to edit. The server
        enforces this by checking sender_id == user_id.
        """
        message_id = data.get("message_id")
        new_ciphertext = data.get("ciphertext")

        if not message_id or not new_ciphertext:
            return

        async with database.pool.acquire() as conn:
            # Only allow the original sender to edit
            result = await conn.execute(
                """
                UPDATE messages
                SET ciphertext = $1
                WHERE id = $2::uuid AND sender_id = $3::uuid
                """,
                new_ciphertext,
                message_id,
                user_id,
            )

        if result == "UPDATE 0":
            return  # no such message, or not the sender

        # Broadcast the edit to all conversation participants
        targets = await self._get_message_participants(message_id)
        await self.broadcast_to_users(targets, {
            "event": "message_edited",
            "data": {
                "message_id": message_id,
                "edited_by": user_id,
                "ciphertext": new_ciphertext,
            },
        })

    async def handle_message_delete(self, user_id: str, data: dict):
        """Soft-delete a message by setting is_deleted = true.

        The ciphertext stays in the DB but the client will show a
        "this message was deleted" placeholder instead.
        """
        message_id = data.get("message_id")

        if not message_id:
            return

        async with database.pool.acquire() as conn:
            # Only the sender can delete their own message
            result = await conn.execute(
                """
                UPDATE messages
                SET is_deleted = true, ciphertext = ''
                WHERE id = $1::uuid AND sender_id = $2::uuid
                """,
                message_id,
                user_id,
            )

        if result == "UPDATE 0":
            return

        # Notify the conversation that this message is gone
        targets = await self._get_message_participants(message_id)
        await self.broadcast_to_users(targets, {
            "event": "message_deleted",
            "data": {
                "message_id": message_id,
                "deleted_by": user_id,
            },
        })

    async def handle_webrtc_signal(self, sender_id: str, data: dict):
        """Relay WebRTC signaling data between two peers.

        WebRTC needs a signaling channel to negotiate peer-to-peer
        connections (used for direct file transfer). The server just
        forwards the signal to the target — it never inspects the data.
        """
        target_id = data.get("target_id")
        signal_data = data.get("signal")

        if not target_id or not signal_data:
            return

        await self.send_personal(target_id, {
            "event": "webrtc_signal",
            "data": {
                "from": sender_id,
                "signal": signal_data,
            },
        })

    async def handle_create_group(self, sender_id: str, data: dict):
        """Create a new group and add members."""
        group_name = data.get("name", "").strip()
        member_ids = data.get("members", [])

        if not group_name:
            return await self.send_personal(sender_id, {
                "event": "error", "data": {"message": "Group name required"},
            })

        if sender_id not in member_ids:
            member_ids = [sender_id] + list(member_ids)

        key_bundle = data.get("key_bundle")

        async with database.pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO groups (name, created_by)
                VALUES ($1, $2::uuid)
                RETURNING id, created_at
                """,
                group_name, sender_id,
            )
            group_id = str(row["id"])

            for uid in member_ids:
                await conn.execute(
                    "INSERT INTO group_members (group_id, user_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING",
                    group_id, uid,
                )

            # Store group key bundle message if supplied by group creator
            if key_bundle:
                await conn.execute(
                    """
                    INSERT INTO messages (sender_id, group_id, ciphertext, message_type)
                    VALUES ($1::uuid, $2::uuid, $3, 'group_key_bundle')
                    """,
                    sender_id, group_id, str(key_bundle),
                )

        # Notify all members
        await self.broadcast_to_users(member_ids, {
            "event": "group_created",
            "data": {
                "id": group_id,
                "name": group_name,
                "created_by": sender_id,
                "members": member_ids,
                "key_bundle": key_bundle,
            },
        })

    async def _get_group_members(self, group_id: str) -> list[str]:
        """Fetch all member user IDs for a group."""
        async with database.pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT user_id FROM group_members WHERE group_id = $1::uuid",
                group_id,
            )
        return [str(r["user_id"]) for r in rows]

    async def handle_leave_group(self, user_id: str, data: dict):
        """Remove caller from group and broadcast member_left to remaining members."""
        group_id = data.get("group_id")
        if not group_id:
            return

        async with database.pool.acquire() as conn:
            await conn.execute(
                "DELETE FROM group_members WHERE group_id = $1::uuid AND user_id = $2::uuid",
                group_id, user_id,
            )

        # Broadcast member_left to remaining members
        remaining = await self._get_group_members(group_id)
        await self.broadcast_to_users(remaining, {
            "event": "member_left",
            "data": {
                "group_id": group_id,
                "user_id": user_id,
            },
        })

    async def handle_remove_member(self, user_id: str, data: dict):
        """Allow group creator to remove a member and broadcast member_removed."""
        group_id = data.get("group_id")
        target_user_id = data.get("target_user_id") or data.get("user_id")
        if not group_id or not target_user_id:
            return

        async with database.pool.acquire() as conn:
            group = await conn.fetchrow(
                "SELECT created_by FROM groups WHERE id = $1::uuid", group_id
            )
            # Only the creator of the group can remove members
            if not group or str(group["created_by"]) != user_id:
                return await self.send_personal(user_id, {
                    "event": "error", "data": {"message": "Only the group creator can remove members"},
                })

            await conn.execute(
                "DELETE FROM group_members WHERE group_id = $1::uuid AND user_id = $2::uuid",
                group_id, target_user_id,
            )

        # Broadcast member_removed to remaining members + removed user so their UI updates
        remaining = await self._get_group_members(group_id)
        targets = list(set(remaining + [target_user_id]))
        await self.broadcast_to_users(targets, {
            "event": "member_removed",
            "data": {
                "group_id": group_id,
                "user_id": target_user_id,
                "removed_by": user_id,
            },
        })

    async def cleanup_expired_messages(self):
        """Delete messages whose TTL has expired and broadcast message_deleted to participants."""
        async with database.pool.acquire() as conn:
            expired_rows = await conn.fetch(
                """
                SELECT id FROM messages
                WHERE expires_at IS NOT NULL AND expires_at < now()
                """
            )
            if not expired_rows:
                return

            for row in expired_rows:
                msg_id = str(row["id"])
                targets = await self._get_message_participants(msg_id)
                # Clean up dependent rows defensively in case of older DB schemas
                await conn.execute("DELETE FROM message_status WHERE message_id = $1::uuid", row["id"])
                await conn.execute("DELETE FROM reactions WHERE message_id = $1::uuid", row["id"])
                await conn.execute("UPDATE messages SET reply_to_id = NULL WHERE reply_to_id = $1::uuid", row["id"])
                await conn.execute("DELETE FROM messages WHERE id = $1::uuid", row["id"])
                if targets:
                    await self.broadcast_to_users(targets, {
                        "event": "message_deleted",
                        "data": {
                            "message_id": msg_id,
                            "deleted_by": "system",
                        },
                    })


# Create a single shared instance that the WebSocket route will use
manager = ConnectionManager()
