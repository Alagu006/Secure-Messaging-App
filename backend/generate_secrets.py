"""
generate_secrets.py — Generate a cryptographically secure SECRET_KEY for LANChat.

Run this once before first launch:
    cd backend
    python generate_secrets.py

It reads backend/.env, generates a fresh 32-byte hex SECRET_KEY, and writes
it back. The file must contain a SECRET_KEY= line to be replaced.
"""

import os
import secrets
import re

ENV_PATH = os.path.join(os.path.dirname(__file__), ".env")


def main():
    if not os.path.exists(ENV_PATH):
        print(f"Error: {ENV_PATH} not found.")
        print("Create it first with a SECRET_KEY= line, or copy .env.example.")
        return

    with open(ENV_PATH, "r", encoding="utf-8") as f:
        content = f.read()

    # Warn if the default "change-me" value is still in place
    match = re.search(r"^SECRET_KEY\s*=\s*(.+)$", content, re.MULTILINE)
    if match and "change-me" in match.group(1).lower():
        print("Warning: Default 'change-me' SECRET_KEY detected. Generating a new one.")

    new_key = secrets.token_hex(32)  # 32 bytes → 64 hex chars

    if match:
        content = re.sub(
            r"^SECRET_KEY\s*=.*$",
            f"SECRET_KEY={new_key}",
            content,
            count=1,
            flags=re.MULTILINE,
        )
    else:
        content += f"\nSECRET_KEY={new_key}\n"

    with open(ENV_PATH, "w", encoding="utf-8") as f:
        f.write(content)

    print(f"SECRET_KEY generated and written to {ENV_PATH}")
    print("Keep this key secret — it is used to sign user sessions.")


if __name__ == "__main__":
    main()
