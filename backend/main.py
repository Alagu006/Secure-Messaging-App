"""
main.py — LANChat server entry point.

This is the file you run with Uvicorn to start the whole backend.
It wires together the database, the routes, the WebSocket manager,
LAN discovery, and graceful shutdown.
"""

import os
import time
import json
import asyncio
from contextlib import asynccontextmanager
from collections import defaultdict
from datetime import datetime

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, HTTPException
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from database import create_pool, close_pool, create_tables
from routes.auth import router as auth_router
from routes.files import router as files_router
from routes.messages import router as messages_router
from websocket.manager import manager, _verify_token
from discovery import DiscoveryService

# ── Frontend static files ─────────────────────────────────────────────────
FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend", "dist")
os.makedirs(FRONTEND_DIR, exist_ok=True)

# ── Config ──────────────────────────────────────────────────────────────────
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))
START_TIME = time.time()

# ── Rate limiter ────────────────────────────────────────────────────────────
# Tracks message timestamps per user so we can enforce 60 msg/min.
rate_limit_store: dict[str, list[float]] = defaultdict(list)
RATE_LIMIT = 60        # max messages
RATE_WINDOW = 60       # per 60 seconds
MAX_MSG_SIZE = 1_000_000  # 1 MB max per WebSocket message


def check_rate_limit(user_id: str):
    """Raise HTTPException if user has exceeded the rate limit.

    Uses a sliding window: we keep timestamps of the last N messages
    and remove any older than 60 seconds.
    """
    now = time.time()
    timestamps = rate_limit_store[user_id]
    # Remove timestamps outside the window
    rate_limit_store[user_id] = [t for t in timestamps if now - t < RATE_WINDOW]
    if len(rate_limit_store[user_id]) >= RATE_LIMIT:
        raise HTTPException(status_code=429, detail="Rate limit exceeded — 60 messages/minute")
    rate_limit_store[user_id].append(now)


# ── Discovery ───────────────────────────────────────────────────────────────
discovery = DiscoveryService(port=PORT)


# ── Suppress Windows asyncio transport cleanup errors ──────────────────────
# On Windows, when a client disconnects abruptly, the proactor event loop's
# internal transport cleanup tries to shutdown() an already-closed socket,
# raising ConnectionResetError. This is harmless but noisy.
def _ignore_connection_reset(loop, context):
    exc = context.get("exception")
    if isinstance(exc, ConnectionResetError):
        return  # silently ignore
    loop.default_exception_handler(context)


# ── Lifespan (startup / shutdown) ───────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Runs once when the server starts, and once when it stops.

    On start:  connect to PostgreSQL, create tables, start LAN discovery
    On stop:   close all connections, stop discovery
    """
    # ── STARTUP ───────────────────────────────────────────────────────────
    await create_pool()
    await create_tables()
    loop = asyncio.get_event_loop()
    loop.set_exception_handler(_ignore_connection_reset)
    # Start LAN discovery in a background thread (Zeroconf is synchronous)
    await loop.run_in_executor(None, discovery.start)
    await loop.run_in_executor(None, discovery.print_qr)
    print(f"[server] LANChat running on http://{discovery.ip}:{PORT}")

    yield

    # ── SHUTDOWN ──────────────────────────────────────────────────────────
    print("[server] Shutting down...")
    # Close all WebSocket connections gracefully
    await manager.disconnect_all()
    # Stop LAN discovery
    await loop.run_in_executor(None, discovery.stop)
    # Close database connections
    await close_pool()
    print("[server] Goodbye!")


app = FastAPI(
    title="LANChat",
    description="A LAN-only encrypted chat server. No internet required.",
    lifespan=lifespan,
)

# CORS — allow the frontend from LAN IPs and localhost only
_lan_ip = discovery.ip if hasattr(discovery, 'ip') else '127.0.0.1'
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        f"http://{_lan_ip}:5173",
        f"https://{_lan_ip}:5173",
        f"http://{_lan_ip}:8000",
        f"https://{_lan_ip}:8000",
        "http://localhost:5173",
        "https://localhost:5173",
        "http://localhost:8000",
        "https://localhost:8000",
        "http://127.0.0.1:5173",
        "https://127.0.0.1:5173",
        "http://127.0.0.1:8000",
        "https://127.0.0.1:8000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── HTTP Routes ───────────────────────────────────────────────────────────
app.include_router(auth_router)
app.include_router(files_router)
app.include_router(messages_router)


@app.get("/api/hello")
async def root():
    """Health-check / hello world route."""
    return {
        "message": "Hello, LANChat!",
        "server": f"{discovery.ip}:{PORT}",
    }


@app.get("/health")
async def health():
    """Return server health status.

    Shows uptime, connected users, and database connectivity.
    Useful for monitoring and debugging.
    """
    from database import pool as db_pool

    db_status = "unknown"
    if db_pool:
        try:
            async with db_pool.acquire() as conn:
                await conn.execute("SELECT 1")
            db_status = "connected"
        except Exception:
            db_status = "disconnected"

    return {
        "status": "ok",
        "uptime_seconds": int(time.time() - START_TIME),
        "uptime_human": str(datetime.utcfromtimestamp(
            time.time() - START_TIME
        ) - datetime(1970, 1, 1)),
        "connected_users": len(manager.active_connections),
        "database": db_status,
        "version": "1.0",
    }


@app.get("/join", response_class=HTMLResponse)
async def join_page():
    """Show a friendly join page with QR code and server info.

    This is the page the terminal QR code points to. Users on the same
    VLAN can scan it to get the server IP automatically.
    """
    return discovery.get_join_html()


# ── WebSocket endpoint ────────────────────────────────────────────────────

@app.websocket("/ws/{user_id}")
async def websocket_endpoint(
    websocket: WebSocket,
    user_id: str,
    token: str = Query(...),
):
    """Real-time messaging endpoint. Each connected user gets one WebSocket."""

    # Optional Origin check for LAN environments
    origin = websocket.headers.get("origin", "")
    if origin and "localhost" not in origin and "127.0.0.1" not in origin:
        allowed_prefixes = [f"http://{discovery.ip}", f"https://{discovery.ip}"]
        if not any(origin.startswith(p) for p in allowed_prefixes):
            await websocket.close(code=4001)
            return

    payload = _verify_token(token)
    if payload is None:
        await websocket.close(code=4001)
        return

    token_user_id = payload.get("sub")
    if token_user_id != user_id:
        await websocket.close(code=4001)
        return

    await manager.connect(websocket, user_id)

    try:
        while True:
            raw_text = await websocket.receive_text()
            if len(raw_text) > MAX_MSG_SIZE:
                await websocket.send_json({
                    "event": "error",
                    "data": {"message": "Message too large"},
                })
                continue
            raw = json.loads(raw_text)
            event = raw.get("event")
            data = raw.get("data", {})

            # Apply rate limiting to send_message
            if event == "send_message":
                check_rate_limit(user_id)

            handlers = {
                "send_message": manager.handle_send_message,
                "typing_start": manager.handle_typing_start,
                "typing_stop": manager.handle_typing_stop,
                "message_read": manager.handle_message_read,
                "message_reaction": manager.handle_message_reaction,
                "message_edit": manager.handle_message_edit,
                "message_delete": manager.handle_message_delete,
                "webrtc_signal": manager.handle_webrtc_signal,
                "create_group": manager.handle_create_group,
            }

            if event == "ping":
                await websocket.send_json({"event": "pong"})
            elif event in handlers:
                await handlers[event](user_id, data)
            else:
                await websocket.send_json({
                    "event": "error",
                    "data": {"message": f"Unknown event type: {event}"},
                })

    except WebSocketDisconnect:
        await manager.disconnect(user_id)
    except Exception as e:
        print(f"[ws] Error for user {user_id}: {e}")
        await manager.disconnect(user_id)


# ── Serve frontend SPA build (production) ────────────────────────────────
if os.path.isdir(FRONTEND_DIR):
    app.mount("/assets", StaticFiles(directory=os.path.join(FRONTEND_DIR, "assets")), name="assets")

    @app.get("/favicon.svg")
    async def favicon():
        return FileResponse(os.path.join(FRONTEND_DIR, "favicon.svg"))

    @app.exception_handler(404)
    async def spa_fallback(request, exc):
        path = request.url.path
        if path.startswith(("/auth", "/files", "/ws", "/health")):
            from fastapi.responses import JSONResponse
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        index_path = os.path.join(FRONTEND_DIR, "index.html")
        if os.path.isfile(index_path):
            return FileResponse(index_path)
        return HTMLResponse("<h1>Not Found</h1>", status_code=404)


# ── Main entry point (supports SSL) ──────────────────────────────────────
if __name__ == "__main__":
    import uvicorn

    ssl_certfile = os.getenv("SSL_CERTFILE")
    ssl_keyfile = os.getenv("SSL_KEYFILE")

    if ssl_certfile and ssl_keyfile:
        # Resolve relative to backend directory
        basedir = os.path.dirname(os.path.abspath(__file__))
        cert = os.path.join(basedir, ssl_certfile)
        key = os.path.join(basedir, ssl_keyfile)
        if os.path.isfile(cert) and os.path.isfile(key):
            print(f"[server] Starting with HTTPS (cert={ssl_certfile}, key={ssl_keyfile})")
            uvicorn.run(
                "main:app",
                host=HOST,
                port=PORT,
                ssl_certfile=cert,
                ssl_keyfile=key,
            )
        else:
            print("[server] SSL files not found, falling back to HTTP")
            uvicorn.run("main:app", host=HOST, port=PORT)
    else:
        print("[server] Starting with HTTP (set SSL_CERTFILE + SSL_KEYFILE for HTTPS)")
        uvicorn.run("main:app", host=HOST, port=PORT)
