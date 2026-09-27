"""
database.py — PostgreSQL connection & table creation.

What this file does:
- Reads DB_URL from your .env file
- Creates a connection pool (a set of reusable database connections)
- Creates all the tables we need (users, messages, groups, etc.)
"""

import os
import asyncpg
from dotenv import load_dotenv

# Load variables from .env into environment
load_dotenv()

# Grab the database URL (e.g. postgresql+asyncpg://user:pass@localhost:5432/lanchat)
DB_URL = os.getenv("DB_URL")

# This will hold our connection pool once the server starts
pool = None


async def create_pool():
    """Start the connection pool.
    FastAPI calls this once when the server starts up.
    min_size=2 means we keep at least 2 connections ready at all times.
    max_size=10 means we never open more than 10 connections."""
    global pool
    pool = await asyncpg.create_pool(
        DB_URL,
        min_size=2,
        max_size=10,
    )


async def close_pool():
    """Shut down the pool.
    FastAPI calls this once when the server shuts down.
    This makes sure we don't leave dangling connections."""
    global pool
    if pool:
        await pool.close()
        pool = None


async def create_tables():
    """Create every table we need, if they don't already exist.
    Safe to call on every startup — IF NOT EXISTS prevents errors."""
    async with pool.acquire() as conn:
        await conn.execute("""
            -- users: everyone who has ever registered on this server
            CREATE TABLE IF NOT EXISTS users (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                username TEXT UNIQUE NOT NULL,
                public_key TEXT NOT NULL,
                wrapped_keys TEXT,
                -- Security fix: Add is_active flag to enable disabling departed user accounts.
                is_active BOOLEAN NOT NULL DEFAULT true,
                last_seen TIMESTAMP,
                created_at TIMESTAMP DEFAULT now()
            );

            -- messages: one row per message (cipherext is never decrypted server-side)
            CREATE TABLE IF NOT EXISTS messages (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                sender_id UUID REFERENCES users(id),
                recipient_id UUID REFERENCES users(id),
                group_id UUID,
                ciphertext TEXT NOT NULL,
                message_type TEXT DEFAULT 'text',
                reply_to_id UUID REFERENCES messages(id) ON DELETE SET NULL,
                is_deleted BOOLEAN DEFAULT false,
                -- Feature: Disappearing messages TTL
                expires_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT now()
            );

            -- message_status: tracks delivery/read state per user
            CREATE TABLE IF NOT EXISTS message_status (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
                user_id UUID REFERENCES users(id),
                status TEXT DEFAULT 'sent',
                updated_at TIMESTAMP DEFAULT now()
            );
            -- Ensure one status row per user per message
            CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_status_msg_user
                ON message_status (message_id, user_id);

            -- reactions: emoji reactions on messages
            -- UNIQUE constraint prevents double-tap exploits (L-08)
            CREATE TABLE IF NOT EXISTS reactions (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
                user_id UUID REFERENCES users(id),
                emoji TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT now(),
                UNIQUE (message_id, user_id, emoji)
            );
            -- Migration for existing databases that lack the UNIQUE constraint
            DO $$ BEGIN
                ALTER TABLE reactions ADD CONSTRAINT reactions_unique_per_user_emoji
                UNIQUE (message_id, user_id, emoji);
            EXCEPTION WHEN duplicate_table THEN
                NULL;
            END $$;

            -- migration: add wrapped_keys if missing (existing databases)
            ALTER TABLE users ADD COLUMN IF NOT EXISTS wrapped_keys TEXT;

            -- migration: add is_active if missing (existing databases)
            -- Security fix: Add is_active column to support disabling departed employee accounts.
            ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

            -- migration: add expires_at if missing (existing databases)
            -- Feature: Add expires_at column for disappearing messages TTL.
            ALTER TABLE messages ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;

            -- migration: foreign key cascade deletes for messages TTL cleanup
            DO $$ BEGIN
                ALTER TABLE message_status DROP CONSTRAINT IF EXISTS message_status_message_id_fkey;
                ALTER TABLE message_status ADD CONSTRAINT message_status_message_id_fkey
                    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE;
            EXCEPTION WHEN others THEN NULL;
            END $$;

            DO $$ BEGIN
                ALTER TABLE reactions DROP CONSTRAINT IF EXISTS reactions_message_id_fkey;
                ALTER TABLE reactions ADD CONSTRAINT reactions_message_id_fkey
                    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE;
            EXCEPTION WHEN others THEN NULL;
            END $$;

            DO $$ BEGIN
                ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_reply_to_id_fkey;
                ALTER TABLE messages ADD CONSTRAINT messages_reply_to_id_fkey
                    FOREIGN KEY (reply_to_id) REFERENCES messages(id) ON DELETE SET NULL;
            EXCEPTION WHEN others THEN NULL;
            END $$;

            -- groups: chat rooms for group messaging
            CREATE TABLE IF NOT EXISTS groups (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                name TEXT NOT NULL,
                created_by UUID REFERENCES users(id),
                created_at TIMESTAMP DEFAULT now()
            );

            -- group_members: which users belong to which groups
            CREATE TABLE IF NOT EXISTS group_members (
                group_id UUID REFERENCES groups(id),
                user_id UUID REFERENCES users(id),
                joined_at TIMESTAMP DEFAULT now(),
                PRIMARY KEY (group_id, user_id)
            );

            -- files: metadata for uploaded files
            CREATE TABLE IF NOT EXISTS files (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                uploader_id UUID REFERENCES users(id),
                recipient_id UUID REFERENCES users(id),
                group_id UUID,
                original_filename TEXT NOT NULL,
                mimetype TEXT,
                size_bytes BIGINT,
                iv TEXT,
                created_at TIMESTAMP DEFAULT now()
            );

            -- migration: add group_id to files if missing (existing databases)
            ALTER TABLE files ADD COLUMN IF NOT EXISTS group_id UUID;
        """)
