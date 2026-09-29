"""
auth.py — Identity and registration endpoints.

Identity model used here:
  - No email, no password, no cloud login.
  - Your identity IS your cryptographic keypair.
  - The server only ever sees your public key — never your private key.
  - To log in you prove you own the private key by signing a challenge (nonce).

Endpoints:
  POST /auth/register   — create a new user (username + public key)
  POST /auth/challenge  — get a random nonce to sign (proves identity)
  POST /auth/verify     — send back the signed nonce, get a JWT session token
  GET  /auth/users      — list every registered user (for key exchange)
"""

import os
import time
import secrets
import base64
import json
import hmac

from fastapi import APIRouter, HTTPException, Request, Header, Depends
from pydantic import BaseModel
# Security fix: Replace python-jose with PyJWT to avoid vulnerable non-constant-time ecdsa (PYSEC-2026-1325).
import jwt
from jwt.exceptions import PyJWTError as JWTError
from datetime import datetime, timedelta

from cryptography.hazmat.primitives.asymmetric.ec import SECP256R1, ECDSA
from cryptography.hazmat.primitives import hashes
from cryptography.exceptions import InvalidSignature

import asyncpg
import database

# ── Router ────────────────────────────────────────────────────────────────
router = APIRouter(prefix="/auth")

# ── JWT config ────────────────────────────────────────────────────────────
# Security fix: Read SECRET_KEY with no default and fail loudly at startup if unset.
SECRET_KEY = os.getenv("SECRET_KEY")
if not SECRET_KEY:
    raise RuntimeError("SECRET_KEY environment variable is not set")
ALGORITHM = "HS256"
# Tokens last 24 hours — adjust if you want shorter sessions
TOKEN_EXPIRE_MINUTES = 60 * 24

# ── In-memory challenge store ─────────────────────────────────────────────
# We store nonces here temporarily so we can verify them later.
# Format: {username: {"nonce": "hex-string", "expires": unix-timestamp}}
# In production you'd use Redis, but for LAN this is fine.
challenges = {}

CHALLENGE_TTL = 300  # seconds (5 minutes)

# Simple IP-based rate limiter for registration
_reg_ip_count: dict[str, list[float]] = {}
REG_RATE_LIMIT = 5
REG_RATE_WINDOW = 3600  # per hour


def _check_reg_rate_limit(ip: str):
    now = time.time()
    timestamps = _reg_ip_count.get(ip, [])
    timestamps = [t for t in timestamps if now - t < REG_RATE_WINDOW]
    if len(timestamps) >= REG_RATE_LIMIT:
        raise HTTPException(status_code=429, detail="Too many registrations from this IP")
    timestamps.append(now)
    _reg_ip_count[ip] = timestamps


def _cleanup_expired_challenges():
    """Remove expired challenges so memory doesn't grow forever."""
    now = time.time()
    expired = [u for u, c in challenges.items() if c["expires"] < now]
    for username in expired:
        del challenges[username]


def _create_jwt(user_id: str, username: str) -> str:
    """Create a signed JWT that the client can use as a session token."""
    payload = {
        "sub": user_id,
        "username": username,
        "exp": datetime.utcnow() + timedelta(minutes=TOKEN_EXPIRE_MINUTES),
        "iat": datetime.utcnow(),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


async def get_current_user(authorization: str = Header(None)):
    """Extract and verify the user_id from a JWT Bearer token."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    token_value = authorization.split(" ")[1]
    try:
        payload = jwt.decode(token_value, SECRET_KEY, algorithms=[ALGORITHM])
        user_id = payload.get("sub")
        username = payload.get("username")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")

    # Security fix: Verify user account is active after decoding JWT to reject disabled accounts.
    async with database.pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT is_active FROM users WHERE id = $1::uuid", user_id
        )
    if not row or not row["is_active"]:
        raise HTTPException(status_code=401, detail="Account disabled")

    return user_id, username


# ── Pydantic models (request/response schemas) ────────────────────────────

class RegisterRequest(BaseModel):
    username: str
    public_key: str  # base64-encoded Ed25519 public key bytes
    wrapped_keys: str | None = None  # encrypted private keys (JSON), optional
    invite_code: str | None = None


class ChallengeRequest(BaseModel):
    username: str


class VerifyRequest(BaseModel):
    username: str
    signed_nonce: str  # base64-encoded Ed25519 signature


class UserOut(BaseModel):
    id: str
    username: str
    public_key: str
    created_at: datetime | None = None


# ── Routes ────────────────────────────────────────────────────────────────

@router.post("/register")
async def register(body: RegisterRequest, request: Request):
    """Register a new user.

    The client generates an ECDSA P-256 keypair locally and sends only the
    public key. The server stores it alongside the chosen username.
    """
    _check_reg_rate_limit(request.client.host)

    # Security fix: Require valid invite code to prevent unauthorized account creation.
    invite_code = os.getenv("INVITE_CODE")
    if not invite_code or not body.invite_code or not hmac.compare_digest(body.invite_code.strip(), invite_code.strip()):
        raise HTTPException(status_code=403, detail="Invalid or missing invite code")

    username = body.username.strip()
    if not username:
        raise HTTPException(status_code=400, detail="Username cannot be empty")

    try:
        # Validate that the public_key is valid ECDSA P-256 before storing
        # The frontend exports two JWK objects (ECDH + ECDSA) as base64 JSON
        raw = base64.b64decode(body.public_key)
        json.loads(raw)  # ensure it's parseable JSON
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid public key format")

    async with database.pool.acquire() as conn:
        try:
            row = await conn.fetchrow(
                """
                INSERT INTO users (username, public_key, wrapped_keys)
                VALUES ($1, $2, $3)
                RETURNING id, username, public_key, created_at
                """,
                username,
                body.public_key,
                body.wrapped_keys,
            )
        except asyncpg.exceptions.UniqueViolationError:
            raise HTTPException(status_code=409, detail="Username already taken")

    return {
        "id": str(row["id"]),
        "username": row["username"],
        "public_key": row["public_key"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
    }


@router.post("/challenge")
async def challenge(body: ChallengeRequest):
    """Request a challenge (nonce) to prove identity.

    The server generates a random 32-byte value, hex-encodes it,
    and remembers it for 5 minutes. The client must sign this nonce
    with their private key and return the signature to /auth/verify.
    """
    _cleanup_expired_challenges()

    username = body.username.strip()

    # Make sure the user exists before giving them a challenge
    async with database.pool.acquire() as conn:
        user = await conn.fetchrow(
            "SELECT id FROM users WHERE username = $1", username
        )
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # Generate a random challenge
    nonce = secrets.token_hex(32)  # 64 hex characters
    challenges[username] = {
        "nonce": nonce,
        "expires": time.time() + CHALLENGE_TTL,
    }

    return {"nonce": nonce}


@router.post("/verify")
async def verify(body: VerifyRequest):
    """Verify a signed challenge and issue a session JWT.

    Steps:
      1. Look up the nonce we gave this user
      2. Load the user's stored public key
      3. Check that the signature is valid for the nonce
      4. If valid, issue a JWT the client can use for future requests
    """
    _cleanup_expired_challenges()

    username = body.username.strip()

    # 1. Retrieve the challenge
    challenge_data = challenges.pop(username, None)
    if not challenge_data:
        raise HTTPException(status_code=400, detail="No active challenge. Request one first.")

    if challenge_data["expires"] < time.time():
        raise HTTPException(status_code=400, detail="Challenge expired. Request a new one.")

    nonce = challenge_data["nonce"]

    # 2. Fetch user's public key from DB
    async with database.pool.acquire() as conn:
        user = await conn.fetchrow(
            "SELECT id, public_key FROM users WHERE username = $1", username
        )
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # 3. Verify the signature
    try:
        # The stored public_key is base64-encoded JSON: {ka: ECDH-JWK, sg: ECDSA-JWK}
        raw = base64.b64decode(user["public_key"])
        key_data = json.loads(raw)
        sg_jwk = key_data["sg"]

        # Decode JWK URL-safe base64 coordinates (handle missing padding)
        def b64u_decode(s):
            m = len(s) % 4
            if m == 0:
                return base64.urlsafe_b64decode(s)
            return base64.urlsafe_b64decode(s + "=" * (4 - m))

        x_int = int.from_bytes(b64u_decode(sg_jwk["x"]), "big")
        y_int = int.from_bytes(b64u_decode(sg_jwk["y"]), "big")
        from cryptography.hazmat.primitives.asymmetric.ec import EllipticCurvePublicNumbers
        public_key = EllipticCurvePublicNumbers(x_int, y_int, SECP256R1()).public_key()

        signature_bytes = base64.b64decode(body.signed_nonce)

        # Web Crypto API returns 64-byte raw (r||s) format, not DER.
        # Convert to DER before verification.
        if len(signature_bytes) == 64:
            from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
            r = int.from_bytes(signature_bytes[:32], "big")
            s = int.from_bytes(signature_bytes[32:], "big")
            signature_bytes = encode_dss_signature(r, s)

        public_key.verify(signature_bytes, nonce.encode("utf-8"), ECDSA(hashes.SHA256()))
    except InvalidSignature:
        raise HTTPException(status_code=401, detail="Invalid signature — you don't own this identity")

    # 4. Valid — issue a JWT
    token = _create_jwt(str(user["id"]), username)

    # Update last_seen
    async with database.pool.acquire() as conn:
        await conn.execute(
            "UPDATE users SET last_seen = now() WHERE id = $1",
            user["id"],
        )

    return {"token": token, "token_type": "bearer"}


@router.post("/wrapped-keys")
async def get_wrapped_keys(
    body: ChallengeRequest,
):
    """Return the user's stored wrapped private keys.

    Returns the encrypted private key data so the client can unlock
    them with the passphrase on any device.
    """
    username = body.username.strip()
    if not username:
        raise HTTPException(status_code=400, detail="Username cannot be empty")
    async with database.pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT wrapped_keys, public_key FROM users WHERE username = $1", username
        )
    if not row or not row["wrapped_keys"]:
        raise HTTPException(status_code=404, detail="No wrapped keys found for this user")
    return {"wrapped_keys": row["wrapped_keys"], "public_key": row["public_key"]}


class UsernameUpdateRequest(BaseModel):
    username: str


@router.patch("/username")
async def update_username(
    body: UsernameUpdateRequest,
    request: Request,
    user_info: tuple = Depends(get_current_user),
):
    """Change the authenticated user's username.

    Requires a valid JWT token. The new username must not be taken.
    """
    user_id, current_username = user_info
    new_username = body.username.strip()
    if not new_username:
        raise HTTPException(status_code=400, detail="Username cannot be empty")

    async with database.pool.acquire() as conn:
        try:
            await conn.execute(
                "UPDATE users SET username = $1 WHERE id = $2::uuid",
                new_username, user_id,
            )
        except asyncpg.exceptions.UniqueViolationError:
            raise HTTPException(status_code=409, detail="Username already taken")

    return {"username": new_username}


def _is_admin(username: str) -> bool:
    """Helper to check if a username has admin privileges."""
    admin_env = os.getenv("ADMIN_USERNAMES", "")
    admin_list = [u.strip() for u in admin_env.split(",") if u.strip()]
    return username in admin_list


@router.get("/is-admin")
async def check_is_admin(user_info: tuple = Depends(get_current_user)):
    """Return whether the current authenticated user has admin privileges."""
    _user_id, username = user_info
    return {"is_admin": _is_admin(username)}


@router.get("/admin/users")
async def admin_list_users(user_info: tuple = Depends(get_current_user)):
    """Admin endpoint to list all users with their account status."""
    _admin_id, admin_username = user_info
    if not _is_admin(admin_username):
        raise HTTPException(status_code=403, detail="Admin privileges required")

    async with database.pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, username, is_active, created_at, last_seen FROM users ORDER BY created_at ASC"
        )
    return [
        {
            "id": str(r["id"]),
            "username": r["username"],
            "is_active": r["is_active"],
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            "last_seen": r["last_seen"].isoformat() if r["last_seen"] else None,
        }
        for r in rows
    ]


@router.patch("/users/{user_id}/disable")
async def disable_user(
    user_id: str,
    user_info: tuple = Depends(get_current_user),
):
    """Admin-only endpoint to disable a user account."""
    _admin_id, admin_username = user_info
    # Security fix: Restrict account disabling to usernames configured in ADMIN_USERNAMES env var.
    if not _is_admin(admin_username):
        raise HTTPException(status_code=403, detail="Admin privileges required")

    async with database.pool.acquire() as conn:
        res = await conn.execute(
            "UPDATE users SET is_active = false WHERE id = $1::uuid", user_id
        )
    if res == "UPDATE 0":
        raise HTTPException(status_code=404, detail="User not found")

    return {"status": "success", "user_id": user_id, "is_active": False}


@router.patch("/users/{user_id}/enable")
async def enable_user(
    user_id: str,
    user_info: tuple = Depends(get_current_user),
):
    """Admin-only endpoint to re-enable a disabled user account."""
    _admin_id, admin_username = user_info
    # Security fix: Restrict account enabling to usernames configured in ADMIN_USERNAMES env var.
    if not _is_admin(admin_username):
        raise HTTPException(status_code=403, detail="Admin privileges required")

    async with database.pool.acquire() as conn:
        res = await conn.execute(
            "UPDATE users SET is_active = true WHERE id = $1::uuid", user_id
        )
    if res == "UPDATE 0":
        raise HTTPException(status_code=404, detail="User not found")

    return {"status": "success", "user_id": user_id, "is_active": True}


@router.get("/users")
async def list_users(user_info: tuple = Depends(get_current_user)):
    """Return every registered user and their public key.

    The client needs other users' public keys to encrypt messages
    before sending them. This endpoint makes key exchange possible
    without any out-of-band communication.
    """
    # Security fix: Require valid JWT token before exposing registered user directory.
    async with database.pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, username, public_key, created_at, last_seen FROM users ORDER BY created_at ASC"
        )

    return [
        {
            "id": str(r["id"]),
            "username": r["username"],
            "public_key": r["public_key"],
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            "last_seen": r["last_seen"].isoformat() if r["last_seen"] else None,
        }
        for r in rows
    ]
