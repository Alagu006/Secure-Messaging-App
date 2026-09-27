import { useEffect, useRef, useCallback, useState } from "react";
import { getApiUrl } from "../utils/serverConfig";

const MAX_RECONNECT_DELAY = 30000;
const BASE_RECONNECT_DELAY = 1000;

/*
  Build the WebSocket URL by taking the API base URL (from getApiUrl)
  and swapping http/https → ws/wss.
  This ensures WebSocket connects to the backend directly, not through
  the Vite proxy (which has issues with WS upgrades in some setups).
*/
function getWsUrl(userId, jwt) {
  const apiBase = getApiUrl();
  const url = new URL(apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/ws/${userId}`;
  url.search = `token=${jwt}`;
  return url.toString();
}

export function useWebSocket(userId, jwt) {
  const wsRef = useRef(null);
  const handlersRef = useRef({});
  const [connected, setConnected] = useState(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef(null);
  const isIntentionalCloseRef = useRef(false);

  const connect = useCallback(() => {
    if (!userId || !jwt) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const url = getWsUrl(userId, jwt);
    const ws = new WebSocket(url);

    ws.onopen = () => {
      setConnected(true);
      reconnectAttemptRef.current = 0;
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      // Skip reconnect if this disconnect was intentional (logout or unmount)
      if (isIntentionalCloseRef.current) return;
      const attempt = reconnectAttemptRef.current;
      const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, attempt), MAX_RECONNECT_DELAY);
      reconnectAttemptRef.current = attempt + 1;
      reconnectTimerRef.current = setTimeout(connect, delay);
    };

    ws.onmessage = (event) => {
      try {
        const { event: type, data } = JSON.parse(event.data);
        const handler = handlersRef.current[type];
        if (handler) handler(data);
      } catch {
        // ignore malformed messages
      }
    };

    wsRef.current = ws;
  }, [userId, jwt]);

  useEffect(() => {
    isIntentionalCloseRef.current = false;
    connect();
    return () => {
      isIntentionalCloseRef.current = true;
      clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect]);

  const send = useCallback((event, data = {}) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ event, data }));
    }
  }, []);

  const on = useCallback((event, handler) => {
    handlersRef.current[event] = handler;
  }, []);

  const off = useCallback((event) => {
    delete handlersRef.current[event];
  }, []);

  return { send, on, off, connected };
}
