import os
from fastapi import APIRouter, Depends, HTTPException, Header
from jose import jwt, JWTError
import database

router = APIRouter(prefix="/messages")

SECRET_KEY = os.getenv("SECRET_KEY")
ALGORITHM = "HS256"


async def get_current_user(authorization: str = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    token = authorization.split(" ")[1]
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload.get("sub")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")


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
