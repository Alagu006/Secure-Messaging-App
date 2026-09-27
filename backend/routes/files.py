"""
files.py — File upload/download endpoints for LANChat.

Provides a fallback HTTP transfer path when WebRTC P2P is unavailable.
Files are stored encrypted on disk (the client encrypts before uploading
and decrypts after downloading — the server never sees plaintext).

Endpoints:
  POST /files/upload     — upload a file (encrypted by client)
  GET  /files/{file_id}  — download a file
  GET  /files/{file_id}/thumbnail  — get image thumbnail (if available)
"""

import os
import uuid
import hashlib
import time
from urllib.parse import quote

from fastapi import APIRouter, UploadFile, File, Form, Depends, HTTPException, Header, Query
from fastapi.responses import FileResponse
from pathlib import Path
# Security fix: Replace python-jose with PyJWT to avoid vulnerable non-constant-time ecdsa (PYSEC-2026-1325).
import jwt
from jwt.exceptions import PyJWTError as JWTError

import database

router = APIRouter(prefix="/files")

# ── Config ──────────────────────────────────────────────────────────────────
# Security fix: Read SECRET_KEY with no fallback and fail loudly at startup if unset.
SECRET_KEY = os.getenv("SECRET_KEY")
if not SECRET_KEY:
    raise RuntimeError("SECRET_KEY environment variable is not set")
ALGORITHM = "HS256"
UPLOAD_DIR = Path("uploads")
THUMB_DIR = UPLOAD_DIR / "thumbnails"
MAX_FILE_SIZE = 524_288_000  # 500 MB
UPLOAD_RATE_LIMIT = 20
UPLOAD_RATE_WINDOW = 3600
_upload_counts: dict[str, list[float]] = {}

# Magic bytes for file type validation (list of tuples to avoid dict key dedup)
MAGIC_BYTES = [
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"RIFF", "image/webp"),  # webp starts with RIFF
    (b"\x00\x00\x00\x20ftyp", "video/mp4"),
    (b"\x00\x00\x00\x1cftyp", "video/mp4"),
    (b"\x1aE\xdf\xa3", "video/webm"),
    (b"OggS", "video/ogg"),
    (b"ID3", "audio/mpeg"),
    (b"\xff\xfb", "audio/mpeg"),
    (b"\xff\xf3", "audio/mpeg"),
    (b"OggS", "audio/ogg"),
    (b"RIFF", "audio/wav"),
    (b"%PDF", "application/pdf"),
    (b"PK\x03\x04", "application/zip"),
    (b"PK\x03\x04", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    (b"PK\x03\x04", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    (b"Rar!\x1a\x07", "application/x-rar-compressed"),
    (b"7z\xbc\xaf\x27\x1c", "application/x-7z-compressed"),
    (b"\x1f\x8b", "application/gzip"),
]

# Map PK\x03\x04 to a single canonical type for detection purposes
_PK_MAGIC = b"PK\x03\x04"


def _detect_pk_mime(data: bytes, declared: str | None) -> str | None:
    """Detect the specific PK archive type from declared Content-Type."""
    if not data.startswith(_PK_MAGIC):
        return None
    known = {
        "application/zip",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }
    if declared and declared in known:
        return declared
    return "application/zip"


def _detect_mime(data: bytes, declared: str | None) -> str:
    """Detect MIME type from magic bytes.

    Only accepts files whose true type (detected via magic bytes)
    matches the declared Content-Type.  If no magic bytes are known
    for the data AND it is not valid UTF-8 plaintext, the file is
    rejected by returning "application/x-blocked".
    """
    # Check PK magic specially (multiple possible matches)
    pk_mime = _detect_pk_mime(data, declared)
    if pk_mime:
        return pk_mime

    for magic, mime in MAGIC_BYTES:
        if magic == _PK_MAGIC:
            continue  # handled above
        if data.startswith(magic):
            # Magic bytes match — must also match declared type
            if declared and mime != declared:
                return "application/x-blocked"
            return mime
    # Plain text (no magic bytes, but decodes as UTF-8)
    try:
        data.decode("utf-8")
        if declared in ("text/plain", "text/csv"):
            return declared
    except UnicodeDecodeError:
        pass
    # Unknown binary — reject
    return "application/x-blocked"

# Allowed MIME types
ALLOWED_TYPES = {
    # Images
    "image/jpeg", "image/png", "image/gif", "image/webp",
    # Video
    "video/mp4", "video/webm", "video/ogg",
    # Audio
    "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm", "audio/x-m4a",
    # Documents
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/plain", "text/csv",
    # Archives
    "application/zip", "application/x-zip-compressed",
    "application/x-rar-compressed", "application/x-7z-compressed",
    "application/gzip",
}


# ── Auth dependency ─────────────────────────────────────────────────────────

async def get_current_user(
    authorization: str = Header(None),
    token: str = Query(None),
):
    # Try Authorization header first, then ?token= query param (for <img> tags / window.open)
    token_value = None
    if authorization and authorization.startswith("Bearer "):
        token_value = authorization.split(" ")[1]
    elif token:
        token_value = token

    if not token_value:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = jwt.decode(token_value, SECRET_KEY, algorithms=[ALGORITHM])
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


# ── Routes ──────────────────────────────────────────────────────────────────

@router.post("/upload")
async def upload_file(
    file: UploadFile = File(...),
    user_id: str = Depends(get_current_user),
    recipient_id: str = Form(None),
    group_id: str = Form(None),
):
    """
    Upload an encrypted file.

    Files must be encrypted client-side before upload. The server stores
    the ciphertext as-is and never inspects the content.

    Validation:
      - MIME type must be in the allowed list (checks magic bytes)
      - Size must not exceed 500 MB
    """
    # Rate limit per user
    now = time.time()
    prev = _upload_counts.get(user_id, [])
    prev = [t for t in prev if now - t < UPLOAD_RATE_WINDOW]
    if len(prev) >= UPLOAD_RATE_LIMIT:
        raise HTTPException(status_code=429, detail="Upload rate limit exceeded")
    prev.append(now)
    _upload_counts[user_id] = prev

    content = await file.read()
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail="File too large (max 500 MB)")

    # Check magic bytes against allowed types
    detected = _detect_mime(content[:32], file.content_type)
    if detected not in ALLOWED_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"File type '{file.content_type or 'unknown'}' is not allowed",
        )

    # Save to disk with a UUID filename
    file_id = str(uuid.uuid4())
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    dest = UPLOAD_DIR / file_id
    with open(dest, "wb") as f:
        f.write(content)

    # Compute SHA-256 checksum of the stored file
    checksum = hashlib.sha256(content).hexdigest()

    # Generate thumbnail for images (unencrypted preview)
    thumbnail_id = None
    if file.content_type and file.content_type.startswith("image/"):
        thumbnail_id = await _generate_thumbnail(dest, file_id)

    # Insert metadata into files table (supporting group_id)
    async with database.pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO files (id, uploader_id, recipient_id, group_id, original_filename, mimetype, size_bytes)
            VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7)
            """,
            file_id, user_id, recipient_id if recipient_id else None, group_id if group_id else None, file.filename, file.content_type, len(content),
        )

    return {
        "file_id": file_id,
        "filename": file.filename,
        "size": len(content),
        "mime_type": file.content_type,
        "checksum": checksum,
        "thumbnail_id": thumbnail_id,
        "group_id": group_id,
    }


async def _check_file_access(file_id: str, user_id: str):
    """Verify that the requesting user is the sender, recipient, or group member.

    Queries the files table in the DB for persistent access control
    that survives server restarts. Raises 403 if unauthorized.
    """
    async with database.pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT uploader_id, recipient_id, group_id FROM files WHERE id = $1::uuid",
            file_id,
        )
    if not row:
        raise HTTPException(status_code=404, detail="File not found")
    uploader = str(row["uploader_id"])
    recipient = str(row["recipient_id"]) if row["recipient_id"] else None
    group_id = str(row["group_id"]) if row["group_id"] else None

    # Uploader and direct recipient always have access
    if user_id == uploader or (recipient and user_id == recipient):
        return

    # If associated with a group, allow any group member to download
    if group_id:
        async with database.pool.acquire() as conn:
            member = await conn.fetchrow(
                "SELECT 1 FROM group_members WHERE group_id = $1::uuid AND user_id = $2::uuid",
                group_id, user_id,
            )
        if member:
            return

    raise HTTPException(status_code=403, detail="Access denied")


@router.get("/{file_id}")
async def download_file(file_id: str, user_id: str = Depends(get_current_user)):
    """
    Download a previously uploaded file.

    The client must decrypt the file after download (the server stores
    ciphertext only).

    Sets Content-Disposition so the browser uses the original filename + extension.
    """
    await _check_file_access(file_id, user_id)
    file_path = UPLOAD_DIR / file_id
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    # Look up original filename and mime type from database
    original_name = file_id  # fallback: UUID with no extension
    media_type = "application/octet-stream"
    async with database.pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT original_filename, mimetype FROM files WHERE id = $1::uuid",
            file_id,
        )
        if row:
            original_name = row["original_filename"]
            if row["mimetype"]:
                media_type = row["mimetype"]

    # Security fix: Sanitize filename by stripping CR/LF/quotes and encoding per RFC 5987 to prevent header injection.
    safe_name = original_name.replace("\r", "").replace("\n", "").replace('"', "")
    encoded_name = quote(safe_name)
    headers = {"Content-Disposition": f"attachment; filename=\"{encoded_name}\"; filename*=utf-8''{encoded_name}"}
    return FileResponse(file_path, media_type=media_type, headers=headers)


@router.get("/{file_id}/thumbnail")
async def get_thumbnail(file_id: str, user_id: str = Depends(get_current_user)):
    """
    Get the thumbnail preview for an image file.

    Returns 404 if no thumbnail was generated (non-image files).
    """
    await _check_file_access(file_id, user_id)
    thumb_path = THUMB_DIR / file_id
    if not thumb_path.exists():
        raise HTTPException(status_code=404, detail="Thumbnail not found")
    return FileResponse(thumb_path, media_type="image/jpeg")


async def _generate_thumbnail(file_path: Path, file_id: str) -> str | None:
    """
    Create a 200x200 JPEG thumbnail of an image file.

    Uses Pillow if available. Silently returns None if Pillow is not
    installed or the image cannot be processed.
    """
    try:
        from PIL import Image

        # Security fix: Cap maximum image pixels to protect against decompression bomb DoS attacks.
        Image.MAX_IMAGE_PIXELS = 64_000_000

        THUMB_DIR.mkdir(parents=True, exist_ok=True)
        thumb_path = THUMB_DIR / file_id
        img = Image.open(file_path)
        img.thumbnail((200, 200))
        img.save(thumb_path, "JPEG")
        return file_id
    except Image.DecompressionBombError:
        return None
    except Exception:
        return None
