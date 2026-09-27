import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import { useAuth } from "../App";
import { useEncryption } from "../hooks/useEncryption";
import { getKeyFingerprint, generateQRData } from "../utils/crypto";
import { getApiUrl } from "../utils/serverConfig";

const API = () => getApiUrl();

export default function SettingsPage() {
  const { auth, setAuth } = useAuth();
  const nav = useNavigate();
  const enc = useEncryption();

  const [fingerprint, setFingerprint] = useState("");
  const [qrData, setQrData] = useState("");
  const [theme, setTheme] = useState(localStorage.getItem("lanchat-theme") || "light");
  const [newUsername, setNewUsername] = useState(auth.username || "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (auth.jwt) {
      fetch(`${API()}/auth/is-admin`, {
        headers: { Authorization: `Bearer ${auth.jwt}` },
      })
        .then((r) => r.json())
        .then((data) => setIsAdmin(!!data.is_admin))
        .catch(() => setIsAdmin(false));
    }
  }, [auth.jwt]);

  useEffect(() => {
    if (enc.identity) {
      getKeyFingerprint(
        enc.identity.keyAgreement.publicKey,
        enc.identity.signing.publicKey
      ).then(setFingerprint);

      generateQRData(
        enc.identity.keyAgreement.publicKey,
        enc.identity.signing.publicKey,
        auth.username || "user"
      ).then(setQrData);
    }
  }, [enc.identity, auth.username]);

  // Apply theme
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("lanchat-theme", theme);
  }, [theme]);

  const handleSaveUsername = async () => {
    if (!newUsername.trim() || newUsername === auth.username) return;
    setSaving(true);
    setMessage("");
    try {
      const res = await fetch(`${API()}/auth/username`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth.jwt}`,
        },
        body: JSON.stringify({ username: newUsername.trim() }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "Failed to update username");
      }
      setAuth((prev) => ({ ...prev, username: newUsername.trim() }));
      setMessage("Username updated!");
    } catch (e) {
      setMessage(e.message);
    }
    setSaving(false);
  };

  return (
    <div className="h-screen flex bg-gray-100">
      <div className="m-auto w-full max-w-lg">
        <div className="bg-white rounded-2xl shadow-xl p-8">
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-2xl font-bold text-whatsapp-teal">Settings</h1>
            <button
              className="text-gray-500 hover:text-gray-700"
              onClick={() => nav("/chat")}
            >
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Display Name */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-1">Display Name</label>
            <div className="flex gap-2">
              <input
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-whatsapp-green"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                maxLength={30}
              />
              <button
                className="bg-whatsapp-green text-white px-4 py-2 rounded-lg hover:bg-whatsapp-green-dark disabled:opacity-50"
                onClick={handleSaveUsername}
                disabled={saving || !newUsername.trim() || newUsername === auth.username}
              >
                {saving ? "..." : "Save"}
              </button>
            </div>
            {message && <p className="text-sm text-gray-500 mt-1">{message}</p>}
          </div>

          {/* Key Fingerprint */}
          <div className="bg-gray-50 rounded-lg p-4 mb-6">
            <p className="text-xs text-gray-500 uppercase font-medium mb-2">Key Fingerprint</p>
            <p className="text-sm font-mono text-gray-800 break-all">
              {fingerprint || "Loading..."}
            </p>
            <p className="text-xs text-gray-400 mt-1">
              Verify this with others to ensure secure communication.
              If the fingerprints don't match, your messages could be intercepted.
            </p>
          </div>

          {/* QR Code (export public key) */}
          {qrData && (
            <div className="flex justify-center mb-6">
              <div className="bg-white p-3 rounded-lg border text-center">
                <QRCodeSVG value={qrData} size={180} />
                <p className="text-xs text-gray-500 mt-2">Scan to get my public key</p>
              </div>
            </div>
          )}

          {/* Theme Toggle */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">Theme</label>
            <div className="flex gap-3">
              <button
                className={`flex-1 py-2 rounded-lg border text-sm font-medium transition ${
                  theme === "light"
                    ? "bg-whatsapp-green text-white border-whatsapp-green"
                    : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
                }`}
                onClick={() => setTheme("light")}
              >
                ☀️ Light
              </button>
              <button
                className={`flex-1 py-2 rounded-lg border text-sm font-medium transition ${
                  theme === "dark"
                    ? "bg-whatsapp-green text-white border-whatsapp-green"
                    : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
                }`}
                onClick={() => setTheme("dark")}
              >
                🌙 Dark
              </button>
            </div>
          </div>

          {/* Account Info */}
          <div className="bg-gray-50 rounded-lg p-4 mb-6">
            <p className="text-xs text-gray-500 uppercase font-medium mb-2">Account</p>
            <p className="text-sm text-gray-700">
              User ID: <span className="font-mono text-xs">{auth.userId}</span>
            </p>
            <p className="text-sm text-gray-700 mt-1">
              Keys stored locally in IndexedDB — encrypted with your passphrase.
            </p>
          </div>

          {/* Admin panel link */}
          {isAdmin && (
            <div className="mb-6">
              <button
                className="w-full bg-blue-600 text-white font-medium py-2.5 rounded-lg hover:bg-blue-700 transition flex items-center justify-center gap-2 shadow-sm"
                onClick={() => nav("/admin")}
              >
                <span>🛡️ Open Admin Panel</span>
              </button>
            </div>
          )}

          {/* Back button */}
          <button
            className="w-full bg-gray-100 text-gray-700 font-medium py-2.5 rounded-lg hover:bg-gray-200 transition"
            onClick={() => nav("/chat")}
          >
            Back to Chat
          </button>
        </div>
      </div>
    </div>
  );
}
