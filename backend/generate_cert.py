"""
generate_cert.py — Generate a self-signed TLS certificate for LANChat.

Run this once before first production launch:
    cd backend
    python generate_cert.py

This creates cert.pem and key.pem in the backend/certs/ directory,
suitable for use with Uvicorn HTTPS on a LAN IP.

Mobile users will see a security warning the first time they connect —
they must accept it (see instructions below).
"""
import socket
import ipaddress
import pathlib
from datetime import datetime, timedelta
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import (
    Encoding, PrivateFormat, NoEncryption,
)

CERTS_DIR = pathlib.Path(__file__).parent / "certs"
CERT_FILE = CERTS_DIR / "cert.pem"
KEY_FILE = CERTS_DIR / "key.pem"


def get_lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip


def main():
    CERTS_DIR.mkdir(parents=True, exist_ok=True)

    lan_ip = get_lan_ip()
    print(f"[certs] LAN IP detected: {lan_ip}")

    # Generate RSA private key
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    # Build subject and SANs
    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, "US"),
        x509.NameAttribute(NameOID.STATE_OR_PROVINCE_NAME, "LAN"),
        x509.NameAttribute(NameOID.LOCALITY_NAME, "Local"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "LANChat"),
        x509.NameAttribute(NameOID.COMMON_NAME, f"{lan_ip}"),
    ])

    san_list = [
        x509.DNSName("localhost"),
        x509.IPAddress(ipaddress.IPv4Address("127.0.0.1")),
        x509.IPAddress(ipaddress.IPv4Address(lan_ip)),
    ]

    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.utcnow())
        .not_valid_after(datetime.utcnow() + timedelta(days=3650))  # 10 years
        .add_extension(x509.SubjectAlternativeName(san_list), critical=False)
        .add_extension(
            # Security fix: Set ca=False since this is a leaf/server certificate, not a CA.
            x509.BasicConstraints(ca=False, path_length=None), critical=True
        )
        .sign(key, hashes.SHA256())
    )

    # Write cert and key
    with open(CERT_FILE, "wb") as f:
        f.write(cert.public_bytes(Encoding.PEM))

    with open(KEY_FILE, "wb") as f:
        f.write(key.private_bytes(
            Encoding.PEM,
            PrivateFormat.TraditionalOpenSSL,
            NoEncryption(),
        ))

    print(f"[certs] Certificate written to {CERT_FILE}")
    print(f"[certs] Private key written to  {KEY_FILE}")
    print()
    print("=" * 60)
    print("MOBILE SETUP — Accepting the self-signed certificate")
    print("=" * 60)
    print()
    print(f"Your server is at: https://{lan_ip}:8000")
    print()
    print("iPhone / iPad:")
    print("  1. Open Safari and go to https://{lan_ip}:8000")
    print("  2. Tap 'Show Details' then 'Visit Website' (accept warning)")
    print("  3. Go to Settings > General > About > Certificate Trust Settings")
    print("  4. Enable the 'LANChat' certificate (it will appear at the bottom)")
    print()
    print("Android:")
    print("  1. Open Chrome and go to https://{lan_ip}:8000")
    print("  2. Tap 'Proceed' (accept warning)")
    print("  3. The cert is trusted for this session")
    print("  (For permanent trust, install the cert via")
    print("   Settings > Security > Install certificate)")
    print()
    print("Desktop (Windows/Mac/Linux):")
    print("  Open https://localhost:8000 in your browser")
    print("  Click 'Advanced' / 'Proceed' to accept.")
    print("  The warning appears once per browser profile.")
    print()
    print("NOTE: Web Crypto API (crypto.subtle) REQUIRES HTTPS")
    print("on any non-localhost origin. This certificate makes")
    print("LANChat work on mobile devices over LAN.")


if __name__ == "__main__":
    main()
