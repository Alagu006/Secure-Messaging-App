const DB_NAME = "lanchat-message-cache";
const DB_VERSION = 1;
const STORE_NAME = "messages";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("convId", "convId", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function cacheMessages(convId, messages) {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  for (const m of messages) {
    store.put({ ...m, convId, cachedAt: Date.now() });
  }
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function getCachedMessages(convId) {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readonly");
  const store = tx.objectStore(STORE_NAME);
  const index = store.index("convId");
  const range = IDBKeyRange.only(convId);
  const messages = await new Promise((resolve, reject) => {
    const results = [];
    const cursor = index.openCursor(range, "prev");
    cursor.onsuccess = (e) => {
      const c = e.target.result;
      if (c) {
        results.push(c.value);
        c.continue();
      } else {
        resolve(results);
      }
    };
    cursor.onerror = () => reject(cursor.error);
  });
  db.close();
  return messages.reverse();
}

export async function clearConvCache(convId) {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  const index = store.index("convId");
  const range = IDBKeyRange.only(convId);
  await new Promise((resolve, reject) => {
    const cursor = index.openCursor(range);
    cursor.onsuccess = (e) => {
      const c = e.target.result;
      if (c) {
        c.delete();
        c.continue();
      } else {
        resolve();
      }
    };
    cursor.onerror = () => reject(cursor.error);
  });
  db.close();
}
