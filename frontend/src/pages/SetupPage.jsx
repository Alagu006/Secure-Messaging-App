import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import { useAuth } from "../App";
import { useEncryption } from "../hooks/useEncryption";
import { getKeyFingerprint, generateQRData, exportWrappedKeysFromStorage } from "../utils/crypto";
import { getApiUrl, initServerConfig } from "../utils/serverConfig";
import { cachePassphrase, cacheSession } from "../utils/crypto";
import ServerConnect from "../components/ServerConnect";

export default function SetupPage() {
  const { setAuth } = useAuth();
  const nav = useNavigate();
  const enc = useEncryption();

  const [step, setStep] = useState(1);
  const [username, setUsername] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [keyPair, setKeyPair] = useState(null);
  const [fingerprint, setFingerprint] = useState("");
  const [qrData, setQrData] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [apiError, setApiError] = useState("");

  useEffect(() => {
    initServerConfig().then(() => setReady(true));
  }, []);

  const handleGenerate = async () => {
    if (!username.trim()) { setError("Pick a username"); return; }
    if (!inviteCode.trim()) { setError("Invite code required"); return; }
    if (passphrase.length < 8) { setError("Passphrase must be 8+ characters"); return; }
    if (passphrase !== confirmPass) { setError("Passphrases don't match"); return; }
    setError("");
    setLoading(true);
    try {
      const kp = await enc.generateAndStore(passphrase);
      setKeyPair(kp);

      const fp = await getKeyFingerprint(
        kp.keyAgreement.publicKey,
        kp.signing.publicKey
      );
      setFingerprint(fp);

      const qr = await generateQRData(
        kp.keyAgreement.publicKey,
        kp.signing.publicKey,
        username
      );
      setQrData(qr);

      setStep(2);
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  };

  const handleRegister = async () => {
    setLoading(true);
    setError("");
    setApiError("");
    const API = getApiUrl();
    try {
      const publicKeyB64 = await enc.exportKeys();
      const wrappedKeysB64 = await exportWrappedKeysFromStorage();
      const res = await fetch(`${API}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username.trim(),
          public_key: publicKeyB64,
          wrapped_keys: wrappedKeysB64,
          invite_code: inviteCode.trim(),
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "Registration failed");
      }
      const user = await res.json();
      cachePassphrase(passphrase);
      cacheSession(user.id, username.trim(), "");
      setAuth((prev) => ({ ...prev, userId: user.id, username: user.username, keyPair }));
      nav("/login");
    } catch (e) {
      if (e.message.includes("fetch") || e.message.includes("NetworkError")) {
        setApiError("Cannot reach the server. Use the server connection section below.");
      }
      setError(e.message);
    }
    setLoading(false);
  };

  if (!ready) {
    return (
      <div className="h-screen flex bg-gray-100">
        <div className="m-auto text-gray-400 text-sm">Loading...</div>
      </div>
    );
  }

  return (
    <div className="h-screen flex bg-gray-100 flex-col items-center justify-center py-6">
      <div className="w-full max-w-md mb-4">
        <div className="bg-white rounded-2xl shadow-xl p-8">
          <div className="text-center mb-6">
            <h1 className="text-2xl font-bold text-whatsapp-teal">LANChat</h1>
            <p className="text-gray-500 text-sm mt-1">End-to-end encrypted</p>
          </div>

          {step === 1 && (
            <>
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">Username</label>
                <input
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-whatsapp-green"
                  placeholder="Choose a display name"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  maxLength={30}
                />
              </div>

              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">Invite Code</label>
                <input
                  type="text"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-whatsapp-green"
                  placeholder="Enter organization invite code"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                />
              </div>

              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">Passphrase</label>
                <input
                  type="password"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-whatsapp-green"
                  placeholder="Protect your private key (8+ chars)"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                />
              </div>

              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-1">Confirm passphrase</label>
                <input
                  type="password"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-whatsapp-green"
                  placeholder="Type it again"
                  value={confirmPass}
                  onChange={(e) => setConfirmPass(e.target.value)}
                />
              </div>

              {error && <p className="text-red-500 text-sm mb-4">{error}</p>}

              <button
                className="w-full bg-whatsapp-green text-white font-semibold py-2.5 rounded-lg hover:bg-whatsapp-green-dark transition"
                onClick={handleGenerate}
                disabled={loading}
              >
                {loading ? "Generating keys..." : "Generate Identity"}
              </button>

              <p className="text-xs text-gray-400 text-center mt-4">
                Your key pair is generated locally. Private key never leaves this device.
              </p>
            </>
          )}

          {step === 2 && (
            <>
              <div className="text-center mb-4">
                <div className="w-16 h-16 bg-whatsapp-teal rounded-full flex items-center justify-center mx-auto mb-2">
                  <span className="text-white text-2xl font-bold">{username[0]?.toUpperCase()}</span>
                </div>
                <h2 className="font-semibold text-lg">{username}</h2>
              </div>

              <div className="bg-gray-50 rounded-lg p-4 mb-4">
                <p className="text-xs text-gray-500 uppercase font-medium mb-2">Key Fingerprint</p>
                <p className="text-sm font-mono text-gray-800 break-all">{fingerprint}</p>
                <p className="text-xs text-gray-400 mt-1">
                  Verify this with others to ensure secure communication
                </p>
              </div>

              {qrData && (
                <div className="flex justify-center mb-4">
                  <div className="bg-white p-3 rounded-lg border">
                    <QRCodeSVG value={qrData} size={160} />
                  </div>
                </div>
              )}

              {apiError && <p className="text-yellow-600 text-xs mb-2">{apiError}</p>}
              {error && <p className="text-red-500 text-sm mb-4">{error}</p>}

              <button
                className="w-full bg-whatsapp-green text-white font-semibold py-2.5 rounded-lg hover:bg-whatsapp-green-dark transition"
                onClick={handleRegister}
                disabled={loading}
              >
                {loading ? "Registering..." : "Register on Server"}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-xl p-8">
          <ServerConnect />
        </div>
      </div>
    </div>
  );
}
