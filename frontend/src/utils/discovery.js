/*
 * discovery.js — LAN server discovery for LANChat.
 *
 * Tries to find the LANChat server on the local network using:
 *   1. Zeroconf/mDNS lookup (via a well-known local HTTP endpoint)
 *   2. Server IP stored in IndexedDB from a previous session
 *   3. User-entered IP as fallback
 *
 * USAGE:
 *   import { discoverServer, connectByIP, getServerUrl } from "./utils/discovery";
 *
 *   const url = await discoverServer();         // auto-discover
 *   await connectByIP("192.168.1.50", 8000);    // manual IP
 *   const saved = await getServerUrl();         // get cached URL
 */

const STORE_NAME = "serverConfig";
const DB_NAME = "lanchat-config";
const DISCOVERY_PORT = 8000;

// Try common LAN subnets for discovery
const COMMON_SUBNETS = [
  "192.168.1",
  "192.168.0",
  "192.168.2",
  "10.0.0",
  "10.0.1",
  "172.16.0",
];

/**
 * Open (or create) the config IndexedDB.
 */
function openConfigDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Save the server URL to IndexedDB so we can reconnect on next launch.
 */
export async function saveServerUrl(url) {
  const db = await openConfigDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  await new Promise((resolve, reject) => {
    const req = store.put({ id: "server", url, updatedAt: Date.now() });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
  db.close();
}

/**
 * Load the previously saved server URL from IndexedDB.
 */
export async function getServerUrl() {
  try {
    const db = await openConfigDB();
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const record = await new Promise((resolve, reject) => {
      const req = store.get("server");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return record ? record.url : null;
  } catch {
    return null;
  }
}

/**
 * Save a server IP + port, and return the full URL.
 */
export async function connectByIP(ip, port = DISCOVERY_PORT) {
  const proto = window.location.protocol === "https:" ? "https" : "http";
  const url = `${proto}://${ip}:${port}`;
  await saveServerUrl(url);
  return url;
}

/**
 * Probe a URL to check if it's a LANChat server.
 * Makes a GET / request and checks the response.
 */
async function probe(host, proto) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const url = `${proto}://${host}:${DISCOVERY_PORT}/api/hello`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    if (data && (data.message || data.server)) {
      return `${proto}://${host}:${DISCOVERY_PORT}`;
    }
    return null;
  } catch {
    return null;
  }
}

async function probeBoth(host) {
  // Try the page's protocol first to avoid mixed content errors
  const pageProto = window.location.protocol === "https:" ? "https" : "http";
  let found = await probe(host, pageProto);
  if (found) return found;
  // Fall back to the other protocol
  const otherProto = pageProto === "https" ? "http" : "https";
  return await probe(host, otherProto);
}

/**
 * Try to discover the LANChat server on the local network.
 *
 * Strategy:
 *   1. First try the hostname that loaded the page (same-device dev mode)
 *   2. Then try common LAN subnets
 *   3. Fall back to the previously saved URL
 *
 * Returns the server URL string, or null if nothing found.
 */
export async function discoverServer() {
  // 1. Try the same host that served the frontend
  const currentHost = window.location.hostname;
  if (currentHost && currentHost !== "localhost" && currentHost !== "127.0.0.1") {
    const found = await probeBoth(currentHost);
    if (found) return found;
  }

  // 2. Try the default local server
  const local = await probeBoth("localhost");
  if (local) return local;
  const localIp = await probeBoth("127.0.0.1");
  if (localIp) return localIp;

  // 3. Try common LAN subnets (last octet .1 to .254)
  for (const subnet of COMMON_SUBNETS) {
    const commonHosts = [".1", ".10", ".50", ".100", ".150", ".200", ".254"];
    for (const host of commonHosts) {
      const found = await probeBoth(`${subnet}${host}`);
      if (found) return found;
    }
  }

  // 4. Fall back to saved URL
  const saved = await getServerUrl();
  if (saved) {
    const urlObj = new URL(saved);
    const found = await probeBoth(urlObj.hostname);
    if (found) return found;
  }

  return null;
}
