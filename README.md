# LANChat

A LAN encrypted messaging web app.

## Backend Setup

```bash
cd backend
python -m venv venv
# Windows:
venv\Scripts\activate
# Linux/Mac:
# source venv/bin/activate

pip install -r requirements.txt
cp .env.example .env   # edit .env with your settings
python generate_secrets.py   # generates a cryptographically random SECRET_KEY
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

> **First time?** Run `python generate_secrets.py` after copying `.env.example` to `.env`.
> It replaces the default `SECRET_KEY=change-me-...` with a secure 64-character hex key.
> Keep this key secret — it is used to sign user sessions.

API docs available at http://localhost:8000/docs

## Frontend Setup

```bash
cd frontend
npm install
npm run dev
```

Opens at http://localhost:5173
