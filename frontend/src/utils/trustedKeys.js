import { importPublicKey, getKeyFingerprint } from "../utils/crypto";

const DB_NAME = "lanchat-trusted-keys";
const STORE_NAME = "trusted";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "userId" });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveTrustedKey(userId, username, publicKeyB64, fingerprint) {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  await new Promise((resolve, reject) => {
    const req = store.put({ userId, username, publicKeyB64, fingerprint, trustedAt: Date.now() });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
  db.close();
}

export async function getTrustedKey(userId) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const record = await new Promise((resolve, reject) => {
      const req = store.get(userId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return record || null;
  } catch {
    return null;
  }
}

export async function isKeyTrusted(userId) {
  const record = await getTrustedKey(userId);
  return !!record;
}

export async function verifyAndTrust(publicKeyB64, username, expectedUserId) {
  const { publicKey, signingPublicKey } = await importPublicKey(publicKeyB64);
  const fingerprint = await getKeyFingerprint(publicKey, signingPublicKey);
  return { fingerprint, publicKey, signingPublicKey };
}
