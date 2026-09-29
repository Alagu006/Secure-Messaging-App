import { useState, useEffect, createContext, useContext } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import SetupPage from "./pages/SetupPage";
import LoginPage from "./pages/LoginPage";
import ChatPage from "./pages/ChatPage";
import SettingsPage from "./pages/SettingsPage";
import AdminPage from "./pages/AdminPage";
import { getCachedSession, getCachedPassphrase, loadKeysFromStorage } from "./utils/crypto";

// ── Auth Context ──────────────────────────────────────────────────────────
export const AuthContext = createContext(null);

export function useAuth() {
  return useContext(AuthContext);
}

// ── Theme Context ─────────────────────────────────────────────────────────
export const ThemeContext = createContext("light");

export function useTheme() {
  return useContext(ThemeContext);
}

export default function App() {
  const [auth, setAuth] = useState({
    userId: null,
    username: null,
    jwt: null,
    keyPair: null,
    loading: true,
  });

  const [hasKeys, setHasKeys] = useState(null);
  const [theme, setTheme] = useState(
    () => localStorage.getItem("lanchat-theme") || "light"
  );

  // Apply theme class to html element
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    if (theme === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }, [theme]);

  useEffect(() => {
    (async () => {
      try {
        // Try session restore first
        const session = getCachedSession();
        const passphrase = getCachedPassphrase();
        if (session && passphrase) {
          const keyPair = await loadKeysFromStorage(passphrase);
          if (keyPair) {
            setAuth({
              userId: session.userId,
              username: session.username,
              jwt: session.jwt,
              keyPair,
              loading: false,
            });
            setHasKeys(true);
            return;
          }
        }
        // Session restore failed — check if keys exist on disk
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open("lanchat-keys", 2);
          req.onupgradeneeded = (e) => {
            const d = e.target.result;
            if (!d.objectStoreNames.contains("identity")) {
              d.createObjectStore("identity", { keyPath: "id" });
            }
          };
          req.onsuccess = (e) => resolve(e.target.result);
          req.onerror = () => reject(req.error);
        });
        const tx = db.transaction("identity", "readonly");
        const store = tx.objectStore("identity");
        const record = await new Promise((resolve) => {
          const r = store.get("main");
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => resolve(null);
        });
        db.close();
        setHasKeys(!!record);
      } catch {
        setHasKeys(false);
      }
      setAuth((prev) => ({ ...prev, loading: false }));
    })();
  }, []);

  if (auth.loading || hasKeys === null) {
    return (
      <div className="h-screen flex items-center justify-center bg-whatsapp-teal">
        <div className="text-white text-xl">LANChat</div>
      </div>
    );
  }

  return (
    <AuthContext.Provider value={{ auth, setAuth, hasKeys }}>
      <ThemeContext.Provider value={{ theme, setTheme }}>
        <BrowserRouter>
          <Routes>
            <Route path="/setup" element={<SetupPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route
              path="*"
              element={
                auth.jwt && auth.keyPair ? (
                  <Navigate to="/chat" replace />
                ) : (
                  <Navigate to={hasKeys ? "/login" : "/setup"} replace />
                )
              }
            />
          </Routes>
        </BrowserRouter>
      </ThemeContext.Provider>
    </AuthContext.Provider>
  );
}
