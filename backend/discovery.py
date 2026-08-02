"""
discovery.py — LAN service discovery for LANChat.

Uses Zeroconf (Bonjour/mDNS) to broadcast the server on the local network
so clients can find it without typing an IP address. Also provides a
/join webpage with a QR code for manual entry on VLANs.

HOW IT WORKS:
  1. On startup, the server registers a service named
     "_lanchat._tcp.local." with its IP and port.
  2. Any device on the same LAN running a Zeroconf browser
     (including our frontend via mDNS lookup) can discover it.
  3. A terminal QR code is printed so users can scan it with their
     phone to open the join page.
  4. The GET /join HTML page shows the server info + QR code.

DEPENDENCIES:
  pip install zeroconf qrcode[pil]
"""

import socket

from zeroconf import Zeroconf, ServiceInfo

# Try to import qrcode — it's optional (for terminal QR display)
try:
    import qrcode
    import qrcode.image.svg
    HAS_QR = True
except ImportError:
    HAS_QR = False


def get_lan_ip():
    """Get the LAN IP address of this machine.

    Opens a UDP socket to a non-routable address (doesn't actually send
    anything) and reads the IP of the interface that would be used.
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip


class DiscoveryService:
    """Zeroconf broadcaster for LANChat.

    Call `start()` after the server is ready, and `stop()` on shutdown.
    """

    def __init__(self, port: int = 8000):
        self.port = port
        self.ip = get_lan_ip()
        self._zeroconf = None
        self._service_info = None

    def start(self):
        """Register the LANChat service on the LAN."""
        if self._zeroconf is not None:
            return  # already running

        self._zeroconf = Zeroconf()

        # Service type: _lanchat._tcp.local.
        # The name includes the hostname so multiple servers on the same
        # network are distinguishable.
        hostname = socket.gethostname()
        service_name = f"LANChat-{hostname}._lanchat._tcp.local."

        self._service_info = ServiceInfo(
            type_="_lanchat._tcp.local.",
            name=service_name,
            addresses=[socket.inet_aton(self.ip)],
            port=self.port,
            properties={"version": "1.0", "name": "LANChat"},
            server=f"{hostname}.local.",
        )

        self._zeroconf.register_service(self._service_info)
        print(f"[discovery] Broadcast as {service_name} ({self.ip}:{self.port})")

    def stop(self):
        """Unregister the service and shut down Zeroconf."""
        if self._zeroconf is None:
            return
        try:
            if self._service_info:
                self._zeroconf.unregister_service(self._service_info)
            self._zeroconf.close()
        except Exception:
            pass
        self._zeroconf = None
        print("[discovery] Stopped")

    def print_qr(self):
        """Print a QR code in the terminal that points to the /join page."""
        if not HAS_QR:
            print("[discovery] Install 'qrcode[pil]' for terminal QR display")
            return

        url = f"http://{self.ip}:{self.port}/join"
        qr = qrcode.QRCode(border=1)
        qr.add_data(url)
        qr.print_ticks = True
        print("\n[discovery] Scan this QR code to open the join page:")
        try:
            qr.print_ascii(invert=True)
        except UnicodeEncodeError:
            # Windows console may not support block chars
            print("  (QR display not supported on this terminal)")
        print(f"  Or open: {url}\n")

    def get_join_html(self):
        """Return an HTML page that shows server info + a QR code for join."""
        url = f"http://{self.ip}:{self.port}"

        # Generate QR as SVG if possible
        qr_svg = ""
        if HAS_QR:
            qr_img = qrcode.make(url, image_factory=qrcode.image.svg.SvgImage)
            qr_svg = qr_img.to_string().decode()

        return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Join LANChat</title>
  <style>
    * {{ margin: 0; padding: 0; box-sizing: border-box; }}
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
           background: #075E54; display: flex; justify-content: center; align-items: center;
           min-height: 100vh; color: #333; }}
    .card {{ background: white; border-radius: 20px; padding: 2rem; max-width: 400px;
             width: 90%; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }}
    h1 {{ color: #075E54; font-size: 1.5rem; margin-bottom: 0.25rem; }}
    .sub {{ color: #666; font-size: 0.9rem; margin-bottom: 1.5rem; }}
    .server-info {{ background: #F0F2F5; border-radius: 12px; padding: 1rem; margin-bottom: 1.5rem; }}
    .server-info p {{ font-size: 0.9rem; color: #555; }}
    .server-info .ip {{ font-size: 1.2rem; font-weight: bold; color: #075E54;
                        font-family: monospace; margin: 0.25rem 0; }}
    .step {{ background: #25D366; color: white; border: none; border-radius: 12px;
             padding: 0.75rem 2rem; font-size: 1rem; font-weight: 600; cursor: pointer;
             display: inline-block; text-decoration: none; margin-top: 1rem;
             transition: background 0.2s; }}
    .step:hover {{ background: #20BD5A; }}
    .qr {{ margin: 1.5rem 0; }}
    .footer {{ font-size: 0.75rem; color: #999; margin-top: 1.5rem; }}
  </style>
</head>
<body>
  <div class="card">
    <h1>LANChat</h1>
    <p class="sub">End-to-end encrypted messaging</p>
    <div class="server-info">
      <p>Server detected on your network</p>
      <p class="ip">{self.ip}:{self.port}</p>
    </div>
    <p style="font-size:0.85rem;color:#666;margin-bottom:1rem;">
      Scan the QR code or enter the IP above in the LANChat app.
    </p>
    {f'<div class="qr">{qr_svg}</div>' if qr_svg else ''}
    <a class="step" href="/" target="_blank">Open LAN Chat</a>
    <p class="footer">Make sure you're on the same WiFi network</p>
  </div>
</body>
</html>"""
