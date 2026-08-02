/*
 * offlineQueue.js — Offline message queue for LANChat.
 *
 * When the WebSocket is disconnected and the user tries to send a message,
 * we save it to an IndexedDB queue. When the connection comes back, we
 * drain the queue and send all pending messages.
 *
 * This gives a seamless experience — messages don't get lost when the
 * server is temporarily unreachable, and the user can keep typing.
 *
 * DATA MODEL (in IndexedDB):
 *   Each queued message is stored as:
 *     { id, recipientId, recipientPublicKey, ciphertext, iv, messageType, replyToId, createdAt }
 *
 * EXPORTS:
 *   openDB()           — open the queue IndexedDB (also used by discovery.js)
 *   enqueueMessage()   — save a message to the queue
 *   getQueueLength()   — how many messages are pending
 *   drainQueue()       — send all queued messages and remove them
 *   clearQueue()       — remove all pending messages
 */

const DB_NAME = "lanchat-queue";
const STORE_NAME = "pending";
const DB_VERSION = 1;

/**
 * Open (or create) the queue IndexedDB.
 * This is exported so discovery.js can reuse it.
 */
export function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        // Use auto-incrementing IDs for the queue
        db.createObjectStore(STORE_NAME, {
          keyPath: "id",
          autoIncrement: true,
        });
      }
    };
    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Save an encrypted message to the offline queue.
 *
 * Parameters match what useMessages.sendMessage() needs
 * to re-send when connection is restored.
 */
export async function enqueueMessage(msg) {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);

  await new Promise((resolve, reject) => {
    const req = store.add({
      recipientId: msg.recipientId,
      recipientPublicKey: msg.recipientPublicKey,
      ciphertext: msg.ciphertext,
      iv: msg.iv,
      messageType: msg.messageType || "text",
      replyToId: msg.replyToId || null,
      queuedAt: Date.now(),
    });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });

  db.close();
}

/**
 * Get the number of pending messages in the queue.
 */
export async function getQueueLength() {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const count = await new Promise((resolve, reject) => {
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return count;
  } catch {
    return 0;
  }
}

/**
 * Drain the queue: get all pending messages and remove them.
 *
 * Returns an array of queued message objects, or empty array if none.
 * After calling this, you should send each message via the WebSocket.
 */
export async function drainQueue() {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);

  const all = await new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  // Clear the queue after reading
  await new Promise((resolve, reject) => {
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });

  db.close();
  return all || [];
}

/**
 * Remove all pending messages from the queue (e.g., on logout).
 */
export async function clearQueue() {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);

  await new Promise((resolve, reject) => {
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });

  db.close();
}
