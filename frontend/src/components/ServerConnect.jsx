import { useState, useEffect } from "react";
import { discoverServer } from "../utils/discovery";
import { subscribe, tryConnect } from "../utils/serverConfig";

export default function ServerConnect() {
  const [ip, setIp] = useState("");
  const [port, setPort] = useState("8000");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [discovered, setDiscovered] = useState(null);
  const [autoScanning, setAutoScanning] = useState(true);

  // Try auto-discovery on mount
  useEffect(() => {
    (async () => {
      const url = await discoverServer();
      if (url) {
        setDiscovered(url);
      }
      setAutoScanning(false);
    })();
  }, []);

  const handleConnect = async () => {
    if (!ip.trim()) { setError("Enter a server IP address"); return; }
    setError("");
    setConnecting(true);
    try {
      const url = await tryConnect(ip.trim(), parseInt(port) || 8000);
      setDiscovered(url);
    } catch {
      setError("Could not reach server at that address");
    }
    setConnecting(false);
  };

  const handleAutoConnect = async () => {
    if (!discovered) return;
    setConnecting(true);
    setError("");
    const { hostname } = new URL(discovered);
    await tryConnect(hostname, 8000);
    setConnecting(false);
  };

  return (
    <div className="border-t pt-4 mt-4">
      <p className="text-xs text-gray-500 uppercase font-medium mb-2">Connect to Server</p>

      {/* Auto-discovery status */}
      {autoScanning && (
        <div className="flex items-center gap-2 text-xs text-gray-400 mb-2">
          <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" strokeDasharray="32" strokeDashoffset="32" />
          </svg>
          Scanning network...
        </div>
      )}

      {!autoScanning && discovered && (
        <button
          className="w-full bg-whatsapp-teal text-white text-sm py-2 rounded-lg hover:bg-whatsapp-teal-dark transition disabled:opacity-50 mb-3"
          onClick={handleAutoConnect}
          disabled={connecting}
        >
          {connecting ? "Connecting..." : `Connect to ${discovered}`}
        </button>
      )}

      {!autoScanning && !discovered && (
        <p className="text-xs text-gray-400 mb-2">No server found automatically — enter the IP manually:</p>
      )}

      {/* Manual IP entry */}
      <div className="flex gap-2">
        <input
          className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-whatsapp-green"
          placeholder="Server IP (e.g. 192.168.1.50)"
          value={ip}
          onChange={(e) => setIp(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleConnect()}
        />
        <input
          className="w-20 border border-gray-300 rounded-lg px-2 py-2 text-sm outline-none focus:ring-2 focus:ring-whatsapp-green text-center"
          placeholder="Port"
          value={port}
          onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
        />
      </div>

      {error && <p className="text-red-500 text-xs mt-2">{error}</p>}

      <button
        className="mt-2 w-full bg-whatsapp-green text-white text-sm py-2 rounded-lg hover:bg-whatsapp-green-dark transition disabled:opacity-50 flex items-center justify-center gap-2"
        onClick={handleConnect}
        disabled={connecting || !ip.trim()}
      >
        {connecting && (
          <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" strokeDasharray="32" strokeDashoffset="32" />
          </svg>
        )}
        {connecting ? "Connecting..." : "Connect"}
      </button>
    </div>
  );
}
