import { useState } from "react";
import { parseQRData, importPublicKey } from "../utils/crypto";

export default function QRScanner({ onScan }) {
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [scanning, setScanning] = useState(false);

  const handleScan = async () => {
    if (!input.trim()) return;
    setError("");
    setScanning(true);
    try {
      const data = parseQRData(input.trim());
      await importPublicKey(data.publicKeyB64);
      onScan(data);
      setInput("");
    } catch (e) {
      setError("Invalid QR data: " + e.message);
    }
    setScanning(false);
  };

  return (
    <div className="p-4 bg-white rounded-lg border">
      <h3 className="font-medium text-sm mb-2">Scan QR Code</h3>
      <p className="text-xs text-gray-500 mb-3">
        Paste a QR code JSON string from another user's setup page
      </p>
      <textarea
        className="w-full border rounded-lg px-3 py-2 text-xs font-mono outline-none focus:ring-2 focus:ring-whatsapp-green"
        rows={3}
        placeholder='{"version":1,"username":"...","publicKeyB64":"..."}'
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />
      {error && <p className="text-red-500 text-xs mt-1">{error}</p>}
      <button
        className="mt-2 bg-whatsapp-teal text-white text-sm px-4 py-1.5 rounded-lg hover:bg-whatsapp-teal-dark transition disabled:opacity-50"
        onClick={handleScan}
        disabled={scanning || !input.trim()}
      >
        {scanning ? "Verifying..." : "Verify & Trust"}
      </button>
    </div>
  );
}
