import os
from fastapi import APIRouter, Depends, HTTPException, Header
# Security fix: Replace python-jose with PyJWT to avoid vulnerable non-constant-time ecdsa (PYSEC-2026-1325).
import jwt
from jwt.exceptions import PyJWTError as JWTError
import database

router = APIRouter(prefix="/messages")

# E2EE Note: Message ciphertext cannot be searched server-side to maintain zero-knowledge privacy; history search is performed client-side in useMessages.js.

# Security fix: Read SECRET_KEY with no fallback and fail loudly at startup if unset.
SECRET_KEY = os.getenv("SECRET_KEY")
if not SECRET_KEY:
    raise RuntimeError("SECRET_KEY environment variable is not set")
ALGORITHM = "HS256"


async def get_current_user(authorization: str = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    token = authorization.split(" ")[1]
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id = payload.get("sub")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")

    # Security fix: Verify user account is active after decoding JWT to reject disabled accounts.
    async with database.pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT is_active FROM users WHERE id = $1::uuid", user_id
        )
    if not row or not row["is_active"]:
        raise HTTPException(status_code=401, detail="Account disabled")

    return user_id


@router.get("/group/{group_id}")
async def get_group_messages(
    group_id: str,
    user_id: str = Depends(get_current_user),
    limit: int = 100,
    before_id: str = None,
):
    """Return messages for a group.

    Verifies the caller is a member of group_members before returning anything.
    Messages are returned in chronological order (oldest first).
    """
    async with database.pool.acquire() as conn:
        member = await conn.fetchrow(
            "SELECT 1 FROM group_members WHERE group_id = $1::uuid AND user_id = $2::uuid",
            group_id, user_id,
        )
        if not member:
            raise HTTPException(status_code=403, detail="Not a member of this group")

        if before_id:
            row = await conn.fetchrow(
                "SELECT created_at FROM messages WHERE id = $1::uuid", before_id
            )
            if not row:
                raise HTTPException(status_code=404, detail="Reference message not found")
            before_ts = row["created_at"]
            rows = await conn.fetch(
                """
                SELECT id, sender_id, recipient_id, group_id, ciphertext, message_type,
                       reply_to_id, is_deleted, created_at
                FROM messages
                WHERE group_id = $1::uuid
                  AND created_at < $2
                ORDER BY created_at DESC
                LIMIT $3
                """,
                group_id, before_ts, limit,
            )
        else:
            rows = await conn.fetch(
                """
                SELECT id, sender_id, recipient_id, group_id, ciphertext, message_type,
                       reply_to_id, is_deleted, created_at
                FROM messages
                WHERE group_id = $1::uuid
                ORDER BY created_at DESC
                LIMIT $2
                """,
                group_id, limit,
            )

    msg_ids = [str(r["id"]) for r in rows]
    read_by_map = {}
    if msg_ids:
        async with database.pool.acquire() as conn:
            status_rows = await conn.fetch(
                """
                SELECT message_id, user_id, status
                FROM message_status
                WHERE message_id = ANY($1::uuid[])
                """,
                msg_ids,
            )
        for sr in status_rows:
            mid = str(sr["message_id"])
            if mid not in read_by_map:
                read_by_map[mid] = {}
            read_by_map[mid][str(sr["user_id"])] = sr["status"]

    result = []
    for r in reversed(rows):
        mid = str(r["id"])
        statuses = read_by_map.get(mid, {})
        result.append({
            "id": mid,
            "sender_id": str(r["sender_id"]),
            "recipient_id": str(r["recipient_id"]) if r["recipient_id"] else None,
            "group_id": str(r["group_id"]) if r["group_id"] else None,
            "ciphertext": r["ciphertext"],
            "message_type": r["message_type"],
            "reply_to_id": str(r["reply_to_id"]) if r["reply_to_id"] else None,
            "is_deleted": r["is_deleted"],
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            "statuses": statuses,
        })

    return result


@router.get("/group/{group_id}/key-bundle")
async def get_group_key_bundle(
    group_id: str,
    user_id: str = Depends(get_current_user),
):
    """Return the most recent group key bundle for a group if caller is a member."""
    async with database.pool.acquire() as conn:
        member = await conn.fetchrow(
            "SELECT 1 FROM group_members WHERE group_id = $1::uuid AND user_id = $2::uuid",
            group_id, user_id,
        )
        if not member:
            raise HTTPException(status_code=403, detail="Not a group member")

        row = await conn.fetchrow(
            """
            SELECT id, sender_id, ciphertext, created_at
            FROM messages
            WHERE group_id = $1::uuid AND message_type = 'group_key_bundle'
            ORDER BY created_at DESC
            LIMIT 1
            """,
            group_id,
        )
    if not row:
        raise HTTPException(status_code=404, detail="No group key bundle found")
    return {
        "id": str(row["id"]),
        "sender_id": str(row["sender_id"]),
        "key_bundle": row["ciphertext"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
    }


@router.get("/{other_user_id}")
async def get_conversation_messages(
    other_user_id: str,
    user_id: str = Depends(get_current_user),
    limit: int = 100,
    before_id: str = None,
):
    """Return messages between the current user and another user.

    Messages are returned in chronological order (oldest first).
    The client is responsible for decrypting each message.
    """
    async with database.pool.acquire() as conn:
        if before_id:
            row = await conn.fetchrow(
                "SELECT created_at FROM messages WHERE id = $1::uuid", before_id
            )
            if not row:
                raise HTTPException(status_code=404, detail="Reference message not found")
            before_ts = row["created_at"]
            rows = await conn.fetch(
                """
                SELECT id, sender_id, recipient_id, ciphertext, message_type,
                       reply_to_id, is_deleted, created_at
                FROM messages
                WHERE ((sender_id = $1::uuid AND recipient_id = $2::uuid)
                    OR (sender_id = $2::uuid AND recipient_id = $1::uuid))
                  AND created_at < $3
                  AND group_id IS NULL
                ORDER BY created_at DESC
                LIMIT $4
                """,
                user_id, other_user_id, before_ts, limit,
            )
        else:
            rows = await conn.fetch(
                """
                SELECT id, sender_id, recipient_id, ciphertext, message_type,
                       reply_to_id, is_deleted, created_at
                FROM messages
                WHERE ((sender_id = $1::uuid AND recipient_id = $2::uuid)
                    OR (sender_id = $2::uuid AND recipient_id = $1::uuid))
                  AND group_id IS NULL
                ORDER BY created_at DESC
                LIMIT $3
                """,
                user_id, other_user_id, limit,
            )

    # Fetch read receipts for these messages
    msg_ids = [str(r["id"]) for r in rows]
    read_by_map = {}
    if msg_ids:
        async with database.pool.acquire() as conn:
            status_rows = await conn.fetch(
                """
                SELECT message_id, user_id, status
                FROM message_status
                WHERE message_id = ANY($1::uuid[])
                """,
                msg_ids,
            )
        for sr in status_rows:
            mid = str(sr["message_id"])
            if mid not in read_by_map:
                read_by_map[mid] = {}
            read_by_map[mid][str(sr["user_id"])] = sr["status"]

    result = []
    for r in reversed(rows):
        mid = str(r["id"])
        statuses = read_by_map.get(mid, {})
        result.append({
            "id": mid,
            "sender_id": str(r["sender_id"]),
            "recipient_id": str(r["recipient_id"]),
            "ciphertext": r["ciphertext"],
            "message_type": r["message_type"],
            "reply_to_id": str(r["reply_to_id"]) if r["reply_to_id"] else None,
            "is_deleted": r["is_deleted"],
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            "statuses": statuses,
        })

    return result
