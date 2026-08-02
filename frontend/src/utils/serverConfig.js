import { connectByIP, getServerUrl } from "./discovery";

let cachedUrl = null;
let listeners = [];

export function subscribe(cb) {
  listeners.push(cb);
  return () => { listeners = listeners.filter((l) => l !== cb); };
}

function notify() {
  listeners.forEach((l) => l(cachedUrl));
}

export function getApiUrl() {
  return cachedUrl || `${window.location.protocol}//${window.location.host}`;
}

export function setApiUrl(url) {
  // Normalize protocol to match the page (fix stale HTTP -> HTTPS migration)
  try {
    const u = new URL(url);
    if (u.protocol !== window.location.protocol) {
      u.protocol = window.location.protocol;
      url = u.toString().replace(/\/$/, "");
    }
  } catch {}
  cachedUrl = url;
  notify();
}

export async function tryConnect(ip, port) {
  const url = await connectByIP(ip, port);
  setApiUrl(url);
  return url;
}

export async function initServerConfig() {
  const saved = await getServerUrl();
  if (saved) {
    // If saved URL protocol doesn't match the page, ignore it
    // (stale cache from HTTP -> HTTPS migration)
    try {
      const u = new URL(saved);
      if (u.protocol !== window.location.protocol) {
        // Don't use the stale URL — the page's own origin is correct
        return;
      }
    } catch { return; }
    setApiUrl(saved);
  }
}
