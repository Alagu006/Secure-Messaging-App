import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../App";
import { useEncryption } from "../hooks/useEncryption";
import { getApiUrl, initServerConfig } from "../utils/serverConfig";
import { cachePassphrase, cacheSession, importWrappedKeysToStorage } from "../utils/crypto";
import { getCachedPassphrase } from "../utils/crypto";
import ServerConnect from "../components/ServerConnect";

export default function LoginPage() {
  const { setAuth } = useAuth();
  const nav = useNavigate();
  const enc = useEncryption();

  const [username, setUsername] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    initServerConfig().then(() => setReady(true)).catch(() => setReady(true));
  }, []);

  const handleLogin = async () => {
    if (!username.trim()) { setError("Enter your username"); return; }
    if (!passphrase) { setError("Enter your passphrase"); return; }
    setError("");
    setLoading(true);

    const API = getApiUrl();

    try {
      // Try local unlock first
      let unlocked = await enc.unlock(passphrase);

      // If local unlock fails, try downloading wrapped keys from server
      if (!unlocked) {
        const wrappedRes = await fetch(`${API}/auth/wrapped-keys`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: username.trim() }),
        });
        if (wrappedRes.ok) {
          const { wrapped_keys } = await wrappedRes.json();
          await importWrappedKeysToStorage(wrapped_keys);
          unlocked = await enc.unlock(passphrase);
        }
      }

      if (!unlocked) {
        throw new Error("Wrong passphrase");
      }

      const chalRes = await fetch(`${API}/auth/challenge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim() }),
      });
      if (!chalRes.ok) {
        const e = await chalRes.json();
        throw new Error(e.detail || "Challenge failed");
      }
      const { nonce } = await chalRes.json();

      const signedNonce = await enc.sign(nonce);

      const verifyRes = await fetch(`${API}/auth/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username.trim(),
          signed_nonce: signedNonce,
        }),
      });
      if (!verifyRes.ok) {
        const e = await verifyRes.json();
        throw new Error(e.detail || "Verification failed");
      }
      const { token } = await verifyRes.json();

      const usersRes = await fetch(`${API}/auth/users`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const users = await usersRes.json();
      const me = users.find((u) => u.username === username.trim());

      const keyPair = enc.identity;
      setAuth({
        userId: me.id,
        username: me.username,
        jwt: token,
        keyPair,
        loading: false,
      });
      cachePassphrase(passphrase);
      cacheSession(me.id, me.username, token);

      nav("/chat");
    } catch (e) {
      setError(e.message);
      enc.signOut();
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
    <div className="h-screen flex bg-gray-100 items-center justify-center">
      <div className="w-full max-w-sm">
        <div className="bg-white rounded-2xl shadow-xl p-8 mb-4">
          <div className="text-center mb-6">
            <h1 className="text-2xl font-bold text-whatsapp-teal">LANChat</h1>
            <p className="text-gray-500 text-sm">Sign in with your passphrase</p>
          </div>

          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">Username</label>
            <input
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-whatsapp-green"
              placeholder="Your username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>

          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-1">Passphrase</label>
            <input
              type="password"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-whatsapp-green"
              placeholder="Your private key passphrase"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleLogin()}
            />
          </div>

          {error && <p className="text-red-500 text-sm mb-4">{error}</p>}

          <button
            className="w-full bg-whatsapp-green text-white font-semibold py-2.5 rounded-lg hover:bg-whatsapp-green-dark transition disabled:opacity-50"
            onClick={handleLogin}
            disabled={loading}
          >
            {loading ? "Signing in..." : "Sign In"}
          </button>

          <p className="text-xs text-gray-400 text-center mt-4">
            First time? <a href="/setup" className="text-whatsapp-teal underline">Create an account</a>
          </p>
        </div>

        <div className="bg-white rounded-2xl shadow-xl p-8">
          <ServerConnect />
        </div>
      </div>
    </div>
  );
}
