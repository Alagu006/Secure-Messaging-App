import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../App";
import { useWebSocket } from "../hooks/useWebSocket";
import { useEncryption } from "../hooks/useEncryption";
import { useMessages } from "../hooks/useMessages";
import { useNotifications, requestNotificationPermission } from "../hooks/useNotifications";
import { enqueueMessage, drainQueue, getQueueLength, clearQueue } from "../utils/offlineQueue";
import MessageBubble from "../components/MessageBubble";
import TypingIndicator from "../components/TypingIndicator";
import UserAvatar from "../components/UserAvatar";
import OnlineStatus from "../components/OnlineStatus";
import ReactionPicker from "../components/ReactionPicker";
import FileAttachment from "../components/FileAttachment";
import VoiceRecorder from "../components/VoiceRecorder";
import QRScanner from "../components/QRScanner";
import * as trustedKeys from "../utils/trustedKeys";
import { getApiUrl } from "../utils/serverConfig";
import {
  createPeerConnection,
  sendFile,
  receiveFile,
  createOffer,
  createAnswer,
  handleSignal,
  cancelTransfer,
} from "../utils/webrtc";

const FILE_ICONS = {
  "image/": "🖼️",
  "video/": "🎬",
  "audio/": "🎵",
  "application/pdf": "📄",
  "text/": "📝",
  "application/zip": "📦",
};
function fileIcon(mime) {
  for (const [pattern, icon] of Object.entries(FILE_ICONS)) {
    if (mime?.startsWith(pattern)) return icon;
  }
  return "📎";
}


export default function ChatPage() {
  const { auth, setAuth } = useAuth();
  const nav = useNavigate();
  const enc = useEncryption(auth.keyPair);

  // ── Core state ──────────────────────────────────────────────────────────
  const [users, setUsers] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [activeConv, setActiveConv] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showNewChat, setShowNewChat] = useState(false);
  const [replyTo, setReplyTo] = useState(null);
  const [showEmoji, setShowEmoji] = useState(false);
  const [messageText, setMessageText] = useState("");

  // ── Mobile / UI state ──────────────────────────────────────────────────
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // ── Offline queue state ────────────────────────────────────────────────
  const [pendingCount, setPendingCount] = useState(0);
  const queueCheckRef = useRef(null);

  // ── Message search state ───────────────────────────────────────────────
  const [showMsgSearch, setShowMsgSearch] = useState(false);
  const [msgSearchQuery, setMsgSearchQuery] = useState("");
  const [msgSearchResults, setMsgSearchResults] = useState([]);

  // ── Trusted keys & QR state ────────────────────────────────────────────
  const [trustedKeysMap, setTrustedKeysMap] = useState({});
  const [showQR, setShowQR] = useState(false);

  // ── Group state ────────────────────────────────────────────────────────
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupMembers, setGroupMembers] = useState([]);

  // ── Disappearing messages & Search highlight state ─────────────────────
  const [ttlSeconds, setTtlSeconds] = useState(0);
  const [highlightedMsgId, setHighlightedMsgId] = useState(null);

  // ── WebRTC state ───────────────────────────────────────────────────────
  const [fileTransfers, setFileTransfers] = useState({});
  const [receivedFile, setReceivedFile] = useState(null);
  const peerConnsRef = useRef({});
  const pendingCandidatesRef = useRef({});

  function signalingCallback(userId) {
    return (signal) => {
      ws.send("webrtc_signal", { target_id: userId, signal });
    };
  }

  // ── WebSocket ──────────────────────────────────────────────────────────
  const ws = useWebSocket(auth.userId, auth.jwt);

  // ── Messages ───────────────────────────────────────────────────────────
  const usersForMessages = useMemo(() => {
    return allUsers.length > 0 ? allUsers : users;
  }, [allUsers, users]);
  const msg = useMessages(ws, enc, auth.userId, usersForMessages, auth.keyPair);

  // ── Notifications ──────────────────────────────────────────────────────
  const notif = useNotifications();

  // ── Sync keyPair from auth context to encryption hook ────────────────
  useEffect(() => {
    if (auth.keyPair && !enc.identity) {
      enc.setKeyPair(auth.keyPair);
    }
  }, [auth.keyPair, enc.identity]);

  // ── Load users ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!auth.jwt) { nav("/login"); return; }
    fetch(`${getApiUrl()}/auth/users`, {
      headers: { Authorization: `Bearer ${auth.jwt}` },
    })
      .then((r) => r.json())
      .then((data) => {
        setAllUsers(data);
        const others = data.filter((u) => u.id !== auth.userId);
        setUsers(others);
      })
      .catch(() => {});
  }, [auth.jwt, auth.userId, nav]);

  // ── Load trusted keys on mount / users change ─────────────────────────
  useEffect(() => {
    (async () => {
      const map = {};
      for (const u of users) {
        map[u.id] = await trustedKeys.isKeyTrusted(u.id);
      }
      setTrustedKeysMap(map);
    })();
  }, [users]);

  // ── Request notification permission on mount ───────────────────────────
  useEffect(() => {
    requestNotificationPermission();
  }, []);

  // ── Register notification click handler ────────────────────────────────
  notif.onNotificationClick((conversationId) => {
    openConversation(conversationId);
    setSidebarOpen(false);
  });

  // ── Show notification for incoming messages ────────────────────────────
  useEffect(() => {
    // Listen for new_message events via msg.messagesByConv changes
    // We can't hook into the WebSocket directly from here, but we can
    // detect new messages by watching for new entries in messagesByConv.
  }, []);

  // ── Drain offline queue on reconnect ───────────────────────────────────
  useEffect(() => {
    if (!ws?.connected) return;
    (async () => {
      const pending = await drainQueue();
      for (const item of pending) {
        const bundled = item.bundledCiphertext || (item.iv && item.ciphertext ? `${item.iv}:${item.ciphertext}` : item.ciphertext);
        if (bundled) {
          ws.send("send_message", {
            recipient_id: item.recipientId || null,
            group_id: item.groupId || null,
            ciphertext: bundled,
            message_type: item.messageType || "text",
            reply_to_id: item.replyToId || null,
            ttl_seconds: item.ttlSeconds || null,
          });
        }
      }
      const count = await getQueueLength();
      setPendingCount(count);
    })();
  }, [ws?.connected, ws]);

  // Poll queue length periodically
  useEffect(() => {
    queueCheckRef.current = setInterval(async () => {
      const count = await getQueueLength();
      setPendingCount(count);
    }, 5000);
    return () => clearInterval(queueCheckRef.current);
  }, []);

  // ── Auto-read messages when in active conversation ─────────────────────
  const lastReadRef = useRef({});
  useEffect(() => {
    if (!activeConv) return;
    const convMessages = msg.messagesByConv[activeConv] || [];
    const unread = convMessages.find((m) => !m.isFromMe && !m.isRead);
    if (unread && lastReadRef.current[activeConv] !== unread.id) {
      lastReadRef.current[activeConv] = unread.id;
      msg.markAsRead(unread.id, activeConv);
    }
  });

  // ── Mark messages as read on tab visibility change ─────────────────────
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible" && activeConv) {
        const convMessages = msg.messagesByConv[activeConv] || [];
        convMessages.forEach((m) => {
          if (!m.isFromMe && !m.isRead) {
            msg.markAsRead(m.id, activeConv);
          }
        });
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [activeConv, msg]);

  // ── Handlers ───────────────────────────────────────────────────────────

  const handleSend = async () => {
    if (!messageText.trim() || !activeConv) return;

    // Bug 2 Fix: Check groups first instead of assuming activeConv is a user ID
    const activeGroupConv = msg.conversations.find((c) => c.userId === activeConv && c.isGroup);
    const isGroup = !!activeGroupConv;

    if (isGroup) {
      if (!ws?.connected) {
        // Offline — queue the message with zero plaintext stored
        try {
          const { iv, ciphertext } = await enc.encryptGroup(activeConv, messageText.trim());
          await enqueueMessage({
            groupId: activeConv,
            ciphertext,
            iv,
            bundledCiphertext: `${iv}:${ciphertext}`,
            messageType: "text",
            replyToId: replyTo?.id || null,
            ttlSeconds: ttlSeconds || null,
          });
          setPendingCount((c) => c + 1);
        } catch (err) {
          console.error("Failed to queue group message:", err);
        }
      } else {
        await msg.sendMessage(
          activeConv,
          null,
          messageText.trim(),
          replyTo?.id || null,
          "text",
          null,
          ttlSeconds,
          true
        );
      }
    } else {
      const user = users.find((u) => u.id === activeConv);
      if (!user) return;

      if (!ws?.connected) {
        // Bug 9 Fix: Offline queue stores only ciphertext and iv — never plaintext
        try {
          const { iv, ciphertext } = await enc.encrypt(user.public_key, messageText.trim());
          await enqueueMessage({
            recipientId: activeConv,
            recipientPublicKey: user.public_key,
            ciphertext,
            iv,
            bundledCiphertext: `${iv}:${ciphertext}`,
            messageType: "text",
            replyToId: replyTo?.id || null,
            ttlSeconds: ttlSeconds || null,
          });
          setPendingCount((c) => c + 1);
        } catch {}
      } else {
        await msg.sendMessage(
          activeConv,
          user.public_key,
          messageText.trim(),
          replyTo?.id || null,
          "text",
          null,
          ttlSeconds,
          false
        );
      }
    }

    setMessageText("");
    setReplyTo(null);
    setShowEmoji(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInputChange = (e) => {
    setMessageText(e.target.value);
    if (activeConv) {
      msg.sendTyping(activeConv, e.target.value.length > 0);
    }
  };

  const openConversation = (userId) => {
    setActiveConv(userId);
    msg.resetUnread(userId);
    // Fetch history if not already loaded
    msg.fetchHistory(userId);
    // Mark all received messages in this conversation as read
    const convMessages = msg.messagesByConv[userId] || [];
    convMessages.forEach((m) => {
      if (!m.isFromMe && !m.isRead) {
        msg.markAsRead(m.id, userId);
      }
    });
  };

  const handleLogout = async () => {
    Object.values(peerConnsRef.current).forEach((c) => cancelTransfer(c.pc, c.dataChannel));
    peerConnsRef.current = {};
    await clearQueue();
    setPendingCount(0);
    enc.signOut();
    setAuth({ userId: null, username: null, jwt: null, keyPair: null, loading: false });
    nav("/login");
  };

  // ── Message search ────────────────────────────────────────────────────
  const handleMsgSearch = async (query) => {
    setMsgSearchQuery(query);
    if (!query.trim() || !activeConv) {
      setMsgSearchResults([]);
      return;
    }
    const results = await msg.searchMessages(query, activeConv);
    setMsgSearchResults(results);
  };

  const scrollToMessage = (msgId) => {
    const el = document.getElementById(`msg-${msgId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setHighlightedMsgId(msgId);
      setTimeout(() => setHighlightedMsgId(null), 2500);
    }
  };

  // ── Create group ──────────────────────────────────────────────────────
  const handleCreateGroup = async () => {
    if (!groupName.trim() || groupMembers.length === 0) return;
    try {
      const memberIds = groupMembers.map((u) => u.id);
      let keyBundle = null;
      let sessionKey = null;

      if (enc.identity) {
        // Creator generates a random AES-256 group session key and encrypts/wraps it for each member
        const myPubKeyB64 = await enc.exportKeys();
        const fullMemberList = [
          ...groupMembers.map((m) => ({ id: m.id, publicKeyB64: m.public_key })),
          { id: auth.userId, publicKeyB64: myPubKeyB64 },
        ];
        const res = await enc.generateGroupBundle(fullMemberList);
        keyBundle = res.bundleJson;
        sessionKey = res.sessionKey;
      }

      // Pre-cache key for the created group
      const onCreated = (data) => {
        if (sessionKey && data.name === groupName.trim()) {
          enc.setGroupKey(data.id, sessionKey);
        }
        ws.off("group_created", onCreated);
      };
      ws.on("group_created", onCreated);

      ws.send("create_group", {
        name: groupName.trim(),
        members: memberIds,
        key_bundle: keyBundle,
      });

      setShowCreateGroup(false);
      setGroupName("");
      setGroupMembers([]);
    } catch (err) {
      console.error("Error creating group:", err);
    }
  };

  // ── QR trust ──────────────────────────────────────────────────────────
  const handleTrustQR = async (data) => {
    try {
      const parsed = JSON.parse(data);
      const { userId, username, publicKey } = parsed;
      if (!userId || !publicKey) return;
      const knownUser = users.find((u) => u.id === userId);
      if (!knownUser) return;
      // Security fix: TOFU trust gate - only call saveTrustedKey after user explicitly confirms the fingerprint matches out-of-band.
      const { fingerprint } = await trustedKeys.verifyAndTrust(publicKey, username, userId);
      const confirmed = window.confirm(
        `Verify identity of "${username}"?\n\nFingerprint:\n${fingerprint}\n\nCompare this with the other user's Settings page.`
      );
      if (confirmed) {
        await trustedKeys.saveTrustedKey(userId, username, publicKey, fingerprint);
        setTrustedKeysMap((prev) => ({ ...prev, [userId]: true }));
      }
    } catch {}
    setShowQR(false);
  };

  const toggleGroupMember = (user) => {
    setGroupMembers((prev) =>
      prev.find((u) => u.id === user.id)
        ? prev.filter((u) => u.id !== user.id)
        : [...prev, user]
    );
  };

  // ── WebRTC signal handler ─────────────────────────────────────────────

  useEffect(() => {
    if (!ws) return;

    const handleWebRTCSignal = async (data) => {
      const remoteId = data.from;
      if (!remoteId || !data.signal) return;

      let conn = peerConnsRef.current[remoteId];

      if (data.signal.type === "offer" && !conn) {
        const pc = createPeerConnection(signalingCallback(remoteId), true).pc;

        pc.ondatachannel = async (event) => {
          const dc = event.channel;
          peerConnsRef.current[remoteId] = { pc, dataChannel: dc };

          const otherUser = users.find((u) => u.id === remoteId);
          if (!otherUser) return;

          const sharedKey = await enc.getSharedKey(otherUser.public_key);
          if (!sharedKey) return;

          receiveFile(dc, sharedKey,
            (percent) => {
              setFileTransfers((prev) => ({
                ...prev,
                [remoteId]: { progress: percent, name: "Receiving file...", status: "receiving", userId: remoteId },
              }));
            },
            async (result) => {
              if (result.error) {
                setFileTransfers((prev) => ({
                  ...prev,
                  [remoteId]: { ...prev[remoteId], status: "error", error: result.message },
                }));
              } else {
                setFileTransfers((prev) => ({
                  ...prev,
                  [remoteId]: { progress: 100, name: result.filename, status: "complete" },
                }));
                setReceivedFile(result);
                const otherUser = users.find((u) => u.id === remoteId);
                if (result.mimeType?.startsWith("audio/")) {
                  msg.sendMessage(remoteId, otherUser?.public_key, "🎵 Voice message");
                } else if (result.mimeType?.startsWith("image/")) {
                  msg.sendMessage(remoteId, otherUser?.public_key, "📷 Photo");
                } else {
                  msg.sendMessage(remoteId, otherUser?.public_key, `📎 ${result.filename}`);
                }
              }
            }
          );
        };

        peerConnsRef.current[remoteId] = { pc, dataChannel: null, role: "receiver" };
        conn = peerConnsRef.current[remoteId];
      }

      if (!conn) return;

      try {
        await handleSignal(conn.pc, data.signal);
        if (data.signal.type === "offer") {
          const answer = await createAnswer(conn.pc);
          ws.send("webrtc_signal", { target_id: remoteId, signal: answer });
          const pending = pendingCandidatesRef.current[remoteId] || [];
          for (const cand of pending) {
            try {
              await conn.pc.addIceCandidate(new RTCIceCandidate(cand));
            } catch {}
          }
          delete pendingCandidatesRef.current[remoteId];
        }
      } catch {}
    };

    ws.on("webrtc_signal", handleWebRTCSignal);
    return () => ws.off("webrtc_signal");
  }, [ws, users, enc, msg]);

  // ── File send ─────────────────────────────────────────────────────────

  const initiateFileSend = useCallback(async (file, recipientId) => {
    const otherUser = users.find((u) => u.id === recipientId);
    if (!otherUser || !enc.identity) return;

    const transferId = crypto.randomUUID();
    setFileTransfers((prev) => ({
      ...prev,
      [transferId]: { progress: 0, name: file.name, status: "connecting", mimeType: file.type, size: file.size, userId: recipientId },
    }));

    try {
      const sharedKey = await enc.getSharedKey(otherUser.public_key);
      if (!sharedKey) throw new Error("No shared key");

      const signalCb = signalingCallback(recipientId);
      const { pc, dataChannel } = createPeerConnection(signalCb);
      peerConnsRef.current[recipientId] = { pc, dataChannel };

      dataChannel.onopen = async () => {
        try {
          setFileTransfers((prev) => ({
            ...prev,
            [transferId]: { ...prev[transferId], status: "sending" },
          }));
          await sendFile(dataChannel, sharedKey, file, (percent) => {
            setFileTransfers((prev) => ({
              ...prev,
              [transferId]: { ...prev[transferId], progress: percent },
            }));
          });
          setFileTransfers((prev) => ({
            ...prev,
            [transferId]: { ...prev[transferId], progress: 100, status: "complete" },
          }));
          // Upload to server for persistence so received files can be opened later
          await uploadFileFallback(file, recipientId, otherUser.public_key);
        } catch {
          setFileTransfers((prev) => ({
            ...prev,
            [transferId]: { ...prev[transferId], status: "error", error: "Send failed" },
          }));
          await uploadFileFallback(file, recipientId, otherUser.public_key);
        }
      };

      dataChannel.onerror = () => {
        setFileTransfers((prev) => ({
          ...prev,
          [transferId]: { ...prev[transferId], status: "error", error: "Data channel error" },
        }));
      };

      const offer = await createOffer(pc);
      signalCb(offer);

      // Timeout: if data channel doesn't open in 15s, fall back to HTTP
      let connected = false;
      const connectTimeout = setTimeout(() => {
        if (!connected) {
          cancelTransfer(pc, dataChannel);
          delete peerConnsRef.current[recipientId];
          setFileTransfers((prev) => ({
            ...prev,
            [transferId]: { ...prev[transferId], status: "error", error: "Connection timed out" },
          }));
          uploadFileFallback(file, recipientId, otherUser.public_key);
        }
      }, 15000);
      const origOnOpen = dataChannel.onopen;
      dataChannel.onopen = (e) => {
        connected = true;
        clearTimeout(connectTimeout);
        origOnOpen(e);
      };
    } catch (err) {
      setFileTransfers((prev) => ({
        ...prev,
        [transferId]: { ...prev[transferId], status: "error", error: err.message },
      }));
      await uploadFileFallback(file, recipientId, otherUser.public_key);
    }
  }, [users, enc, ws, msg]);

  const uploadFileFallback = async (file, targetId, recipientPublicKey = null, isGroup = false) => {
    try {
      const formData = new FormData();
      formData.append("file", file, file.name);
      if (isGroup) {
        formData.append("group_id", targetId);
      } else {
        formData.append("recipient_id", targetId);
      }
      const resp = await fetch(`${getApiUrl()}/files/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${auth.jwt}` },
        body: formData,
      });
      if (!resp.ok) throw new Error("Upload failed");
      const data = await resp.json();
      msg.sendMessage(
        targetId,
        recipientPublicKey,
        `📎 ${file.name}`,
        null,
        "file",
        { fileId: data.file_id, name: file.name, mime: file.type, size: file.size },
        null,
        isGroup
      );
    } catch {}
  };

  const handleCancelTransfer = (transferId) => {
    setFileTransfers((prev) => {
      const entry = prev[transferId];
      if (!entry) return prev;
      const userId = entry.userId;
      const conn = peerConnsRef.current[userId];
      if (conn) {
        cancelTransfer(conn.pc, conn.dataChannel);
        delete peerConnsRef.current[userId];
      }
      return { ...prev, [transferId]: { ...entry, status: "cancelled" } };
    });
  };

  // ── Derived data ───────────────────────────────────────────────────────

  const activeGroup = activeConv ? msg.conversations.find((c) => c.userId === activeConv && c.isGroup) : null;
  const activeUser = activeConv ? users.find((u) => u.id === activeConv) : null;
  const convMessages = activeConv ? msg.messagesByConv[activeConv] || [] : [];
  const isOnline = activeConv ? msg.onlineUsers.has(activeConv) : false;
  const isTyping = activeConv ? msg.typingUsers[activeConv] || false : false;

  // Merge all registered users with conversation metadata for sidebar
  const mergedConvList = useMemo(() => {
    const list = users.map((u) => {
      const conv = msg.conversations.find((c) => c.userId === u.id);
      const lastMsg = conv?.lastMessage || null;
      return {
        userId: u.id,
        username: u.username,
        publicKeyB64: u.public_key,
        lastMessage: lastMsg,
        lastTime: conv?.lastTime || null,
        isOnline: msg.onlineUsers.has(u.id),
        isGroup: false,
        unreadCount: msg.unreadCounts[u.id] || 0,
        lastSeen: u.last_seen || null,
      };
    });

    // Include groups
    msg.conversations.forEach((c) => {
      if (c.isGroup && !list.find((x) => x.userId === c.userId)) {
        list.push({
          userId: c.userId,
          username: c.username,
          publicKeyB64: null,
          lastMessage: c.lastMessage || null,
          lastTime: c.lastTime || null,
          isOnline: false,
          isGroup: true,
          memberIds: c.memberIds || [],
          createdBy: c.createdBy || null,
          unreadCount: msg.unreadCounts[c.userId] || 0,
          lastSeen: null,
        });
      }
    });
    // Sort: unread first, then online, then by most recent message, then alphabetically
    list.sort((a, b) => {
      const aUnread = (msg.unreadCounts[a.userId] || 0) > 0 ? 1 : 0;
      const bUnread = (msg.unreadCounts[b.userId] || 0) > 0 ? 1 : 0;
      if (aUnread !== bUnread) return bUnread - aUnread;
      if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
      if (a.lastTime && b.lastTime) return new Date(b.lastTime) - new Date(a.lastTime);
      if (a.lastTime) return -1;
      if (b.lastTime) return 1;
      return a.username.localeCompare(b.username);
    });
    if (searchQuery) {
      return list.filter((c) =>
        c.username.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }
    return list;
  }, [users, msg.conversations, msg.onlineUsers, msg.unreadCounts, searchQuery]);
  const isConnected = ws?.connected;

  const scrollRef = useRef(null);
  const loadingMoreRef = useRef(false);
  const prevMsgCountRef = useRef(0);

  // Auto-scroll to bottom when new messages arrive (only if already near bottom)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    if (isNearBottom || convMessages.length < prevMsgCountRef.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevMsgCountRef.current = convMessages.length;
  }, [convMessages]);

  // Infinite scroll: load older messages when scrolling to top
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || loadingMoreRef.current) return;
    if (el.scrollTop < 50 && activeConv && msg.hasMoreRef.current[activeConv]) {
      const msgs = msg.messagesByConv[activeConv] || [];
      const oldest = msgs[0];
      if (!oldest) return;
      loadingMoreRef.current = true;
      msg.fetchHistory(activeConv, oldest.id).then(() => {
        loadingMoreRef.current = false;
        // Keep scroll position after prepending
        const prevHeight = el.scrollHeight;
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight - prevHeight + 50;
        });
      }).catch(() => {
        loadingMoreRef.current = false;
      });
    }
  }, [activeConv, msg]);

  return (
    <div className="h-screen flex">
      {/* ─── Mobile sidebar overlay ──────────────────────────────────── */}
      <div
        className={`sidebar-overlay ${sidebarOpen ? "" : "hidden"}`}
        onClick={() => setSidebarOpen(false)}
      />

      {/* ─── Sidebar ──────────────────────────────────────────────────── */}
      <div className={`sidebar-panel w-[420px] min-w-[320px] flex flex-col bg-white border-r border-gray-200 ${sidebarOpen ? "open" : ""}`}>
        {/* Sidebar header */}
        <div className="bg-whatsapp-sidebar-header px-4 py-3 flex items-center justify-between border-b">
          <div className="flex items-center gap-3">
            {/* Hamburger (mobile) */}
            <button
              className="md:hidden p-1 hover:bg-gray-200 rounded-full"
              onClick={() => setSidebarOpen(false)}
            >
              <svg className="w-5 h-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            {!isConnected && (
              <span className="w-2 h-2 bg-red-400 rounded-full animate-pulse" title="Disconnected" />
            )}
            <UserAvatar username={auth.username} size="md" />
          </div>
          <div className="flex gap-3">
            <button onClick={() => setShowMsgSearch(!showMsgSearch)} title="Search messages">
              <svg className="w-5 h-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </button>
            <button onClick={() => setShowQR(true)} title="Scan QR to verify contact">
              <svg className="w-5 h-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
              </svg>
            </button>
            <button onClick={() => setShowNewChat(true)} title="New chat">
              <svg className="w-6 h-6 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
            <button onClick={() => setShowCreateGroup(true)} title="New group">
              <svg className="w-5 h-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
            </button>
            <button onClick={() => nav("/settings")} title="Settings">
              <svg className="w-5 h-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
            <button onClick={handleLogout} title="Logout">
              <svg className="w-6 h-6 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
            </button>
          </div>
        </div>

        {/* Offline banner */}
        {!isConnected && (
          <div className="bg-red-50 text-red-600 text-xs text-center py-1.5 font-medium">
            Connecting... {pendingCount > 0 && `(${pendingCount} pending)`}
          </div>
        )}

        {pendingCount > 0 && isConnected && (
          <div className="bg-yellow-50 text-yellow-700 text-xs text-center py-1.5 font-medium">
            Sending {pendingCount} queued message{pendingCount > 1 ? "s" : ""}...
          </div>
        )}

        {/* Search */}
        <div className="px-3 py-2 bg-whatsapp-sidebar-header">
          <div className="flex items-center bg-white rounded-lg px-3 py-1.5 border">
            <svg className="w-5 h-5 text-gray-400 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              className="flex-1 outline-none text-sm py-1 bg-transparent"
              placeholder="Search or start new chat"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto">
          {mergedConvList.length === 0 && (
            <div className="text-center text-gray-400 text-sm mt-8">
              {searchQuery ? "No users found" : "No other users registered"}
            </div>
          )}
          {mergedConvList.map((conv) => (
            <div
              key={conv.userId}
              className={`flex items-center px-4 py-3 cursor-pointer border-b border-gray-100 hover:bg-gray-50 transition ${
                activeConv === conv.userId ? "bg-gray-100" : ""
              }`}
              onClick={() => {
                openConversation(conv.userId);
                setSidebarOpen(false);
              }}
            >
              <div className="relative mr-3">
                <UserAvatar username={conv.username} size="md" />
                {conv.isOnline ? <OnlineStatus /> : (
                  <span className="absolute bottom-0 right-0 w-3 h-3 bg-gray-300 border-2 border-white rounded-full" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex justify-between items-baseline">
                  <span className="font-medium text-gray-900 truncate">{conv.username}</span>
                  <span className="text-xs text-gray-400 ml-2 whitespace-nowrap">
                    {conv.lastTime
                      ? new Date(conv.lastTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                      : ""}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm text-gray-500 truncate">
                    {conv.lastMessage
                      ? (conv.lastMessage.length > 40 ? conv.lastMessage.slice(0, 40) + "..." : conv.lastMessage)
                      : (conv.lastSeen && !conv.isOnline
                          ? "Last seen " + new Date(conv.lastSeen).toLocaleDateString()
                          : "No messages yet")}
                  </span>
                  {conv.unreadCount > 0 && (
                    <span className="bg-whatsapp-green text-white text-xs rounded-full px-2 py-0.5 ml-2 min-w-[20px] text-center">
                      {conv.unreadCount}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ─── Chat Area ────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col chat-area">
        {!activeConv ? (
          <div className="flex-1 flex items-center justify-center bg-gray-100 text-gray-400">
            <div className="text-center">
              {/* Mobile hamburger */}
              <button
                className="md:hidden mb-4 p-2 bg-whatsapp-green text-white rounded-full"
                onClick={() => setSidebarOpen(true)}
              >
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
              <svg className="w-20 h-20 mx-auto mb-4 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              <p className="text-lg">Select a conversation</p>
              <p className="text-sm">or start a new one</p>
            </div>
          </div>
        ) : (
          <>
            {/* Chat header */}
            <div className="bg-whatsapp-sidebar-header px-4 py-3 flex items-center border-b shadow-sm z-10">
              {/* Mobile hamburger */}
              <button
                className="md:hidden mr-2 p-1 hover:bg-gray-200 rounded-full"
                onClick={() => setSidebarOpen(true)}
              >
                <svg className="w-5 h-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>

              {activeGroup ? (
                <div className="w-9 h-9 rounded-full bg-whatsapp-teal text-white flex items-center justify-center font-bold text-sm">
                  👥
                </div>
              ) : (
                <UserAvatar username={activeUser?.username} size="sm" />
              )}

              <div className="ml-3 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-gray-900">
                    {activeGroup ? activeGroup.username : activeUser?.username}
                  </span>
                  {!activeGroup && activeConv && (
                    <span title={trustedKeysMap[activeConv] ? "Verified" : "Unverified"}>
                      {trustedKeysMap[activeConv] ? (
                        <svg className="w-4 h-4 text-whatsapp-green" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4 text-yellow-500" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-1 6h2v6h-2V7zm0 8h2v2h-2v-2z" />
                        </svg>
                      )}
                    </span>
                  )}
                </div>
                <div className="text-xs text-gray-500">
                  {activeGroup ? (
                    <button
                      onClick={() => setShowGroupModal(true)}
                      className="hover:underline text-whatsapp-green font-medium cursor-pointer"
                    >
                      {activeGroup.memberIds?.length || 0} members (click to view)
                    </button>
                  ) : isTyping ? (
                    <span className="text-whatsapp-green">typing...</span>
                  ) : isOnline ? (
                    <span className="text-whatsapp-green">online</span>
                  ) : (
                    "offline"
                  )}
                </div>
              </div>

              {/* Group actions: Leave group */}
              {activeGroup && (
                <button
                  onClick={() => {
                    if (window.confirm(`Are you sure you want to leave "${activeGroup.username}"?`)) {
                      ws.send("leave_group", { group_id: activeConv });
                      setActiveConv(null);
                    }
                  }}
                  className="mr-2 px-2.5 py-1 text-xs font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition"
                  title="Leave this group"
                >
                  Leave group
                </button>
              )}

              {/* In-chat search toggle */}
              <button
                onClick={() => setShowMsgSearch(!showMsgSearch)}
                className="p-1.5 hover:bg-gray-200 rounded-full"
                title="Search in conversation"
              >
                <svg className="w-5 h-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </button>
            </div>

            {/* In-conversation message search */}
            {showMsgSearch && (
              <div className="bg-white border-b px-4 py-2">
                <div className="flex items-center gap-2">
                  <input
                    className="flex-1 border rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-whatsapp-green"
                    placeholder="Search in this conversation..."
                    value={msgSearchQuery}
                    onChange={(e) => handleMsgSearch(e.target.value)}
                    autoFocus
                  />
                  <button onClick={() => { setShowMsgSearch(false); setMsgSearchQuery(""); setMsgSearchResults([]); }}>
                    <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                {msgSearchQuery && (
                  <p className="text-xs text-gray-400 mt-1">
                    {msgSearchResults.length} result{msgSearchResults.length !== 1 ? "s" : ""}
                  </p>
                )}
                {/* Search results dropdown */}
                {msgSearchResults.length > 0 && (
                  <div className="mt-2 max-h-48 overflow-y-auto divide-y bg-gray-50 rounded-lg border text-xs">
                    {msgSearchResults.map((res) => (
                      <div
                        key={res.id}
                        onClick={() => scrollToMessage(res.id)}
                        className="p-2 hover:bg-gray-100 cursor-pointer flex justify-between items-center transition"
                      >
                        <div className="truncate mr-2">
                          <span className="font-semibold text-gray-700">{res.senderName}: </span>
                          <span className="text-gray-600">{res.plaintext}</span>
                        </div>
                        <span className="text-gray-400 whitespace-nowrap">
                          {res.createdAt ? new Date(res.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Messages */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto chat-bg px-4 py-2" onScroll={handleScroll}>
              {convMessages.length === 0 && (
                <div className="text-center text-gray-400 text-sm mt-8">
                  No messages yet. Say hello!
                </div>
              )}
              {convMessages.map((m, idx) => {
                const isHighlighted = highlightedMsgId === m.id || (msgSearchResults.length > 0 && msgSearchResults.some((x) => x.id === m.id));
                return (
                  <div key={m.id} id={`msg-${m.id}`} className={`msg-enter transition-all duration-300 ${isHighlighted ? "bg-yellow-100 ring-2 ring-yellow-400 rounded-lg -mx-2 px-2 py-1" : ""}`}>
                    <MessageBubble
                      message={m}
                      isOwn={m.isFromMe}
                      isSent={m.isSent}
                      isDelivered={m.isDelivered}
                      isRead={m.isRead}
                      onReply={() => setReplyTo(m)}
                      onReact={(emoji) => msg.sendReaction(m.id, emoji)}
                      onEdit={(newText) => {
                        if (activeGroup) {
                          msg.editMessage(m.id, activeConv, null, newText);
                        } else if (activeUser) {
                          msg.editMessage(m.id, activeConv, activeUser.public_key, newText);
                        }
                      }}
                      onDelete={() => msg.deleteMessage(m.id)}
                      showReply={m.replyToId}
                      replyMessage={m.replyToId ? convMessages.find((x) => x.id === m.replyToId) : null}
                    />
                  </div>
                );
              })}
              {isTyping && (
                <div className="typing-fade">
                  <TypingIndicator />
                </div>
              )}
            </div>

            {/* Reply preview */}
            {replyTo && (
              <div className="bg-whatsapp-sidebar-header px-4 py-2 flex items-center border-t">
                <div className="w-1 h-8 bg-whatsapp-green rounded-full mr-3" />
                <div className="flex-1">
                  <p className="text-xs text-whatsapp-green font-medium">Replying to</p>
                  <p className="text-sm text-gray-600 truncate">{replyTo.plaintext || "Message"}</p>
                </div>
                <button onClick={() => setReplyTo(null)}>
                  <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            )}

            {/* Emoji picker */}
            {showEmoji && (
              <div className="bg-white border-t px-3 py-2 flex gap-1 flex-wrap max-h-32 overflow-y-auto">
                {["😀","😂","😍","🥰","😎","😢","😡","👍","👎","❤️","🔥","🎉","🙏","💯","✅","❌","⭐","💔","😭","🤣","😊","🙂","😉","😌","😏","🙄","😴","🤔","🤗","😇","🤩","😘","😗","😚","😋","😛","😜","🤪","😝","🤑","🤠","😈","🤡","💩","👻","💀","☠️","👋","✌️","🤞","🤟","🤘","🤙","👈","👉","👆","👇","🖕","✊","👊","🤛","🤜","👏","🙌","👐","🤲","🤝","🙏","✍️","💅","👀","🧠","👑","💄","💋","👄"].map((emoji) => (
                  <button
                    key={emoji}
                    className="text-xl hover:bg-gray-100 rounded p-1"
                    onClick={() => {
                      setMessageText((p) => p + emoji);
                      setShowEmoji(false);
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}

            {/* File transfer progress */}
            {Object.entries(fileTransfers).some(
              ([, t]) => t.status === "sending" || t.status === "receiving" || t.status === "connecting"
            ) && (
              <div className="bg-white border-t px-4 py-2 space-y-1 max-h-24 overflow-y-auto">
                {Object.entries(fileTransfers).map(([id, t]) =>
                  (t.status === "sending" || t.status === "receiving" || t.status === "connecting") ? (
                    <div key={id} className="flex items-center gap-3 text-sm">
                      <span className="text-lg">{fileIcon(t.mimeType)}</span>
                      <div className="flex-1 min-w-0">
                        <p className="truncate text-gray-800">
                          {t.status === "connecting" ? "Connecting..." : t.name}
                        </p>
                        <div className="w-full bg-gray-200 rounded-full h-1.5 mt-1">
                          <div
                            className="bg-whatsapp-green h-1.5 rounded-full transition-all"
                            style={{ width: `${t.progress}%` }}
                          />
                        </div>
                      </div>
                      <span className="text-xs text-gray-400 w-10 text-right">
                        {t.status === "connecting" ? "" : `${t.progress}%`}
                      </span>
                      <button
                        onClick={() => handleCancelTransfer(id)}
                        className="text-red-400 hover:text-red-600 text-xs"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : null
                )}
              </div>
            )}

            {/* Received file notification */}
            {receivedFile && !receivedFile.error && (
              <div className="bg-whatsapp-green-light border-t px-4 py-2 flex items-center gap-3">
                <span className="text-2xl">{fileIcon(receivedFile.mimeType)}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{receivedFile.filename}</p>
                  <p className="text-xs text-gray-500">{receivedFile.mimeType}</p>
                </div>
                <a
                  href={URL.createObjectURL(receivedFile.blob)}
                  download={receivedFile.filename}
                  className="bg-whatsapp-green text-white text-xs px-3 py-1.5 rounded-full hover:bg-whatsapp-green-dark"
                  onClick={() => setReceivedFile(null)}
                >
                  Download
                </a>
                <button onClick={() => setReceivedFile(null)} className="text-gray-400">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            )}

            {/* Input bar */}
            <div className="bg-whatsapp-input-bar px-3 py-2 flex items-center gap-2">
              <button onClick={() => setShowEmoji(!showEmoji)} className="p-1.5 hover:bg-gray-200 rounded-full">
                <svg className="w-6 h-6 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </button>

              <FileAttachment
                onAttach={(file) => {
                  if (activeConv) {
                    if (activeGroup) {
                      uploadFileFallback(file, activeConv, null, true);
                    } else {
                      initiateFileSend(file, activeConv);
                    }
                  }
                }}
              />

              <VoiceRecorder
                onSend={(blob, duration) => {
                  if (activeConv) {
                    const file = new File([blob], `voice_${Date.now()}.webm`, { type: "audio/webm" });
                    if (activeGroup) {
                      uploadFileFallback(file, activeConv, null, true);
                    } else {
                      initiateFileSend(file, activeConv);
                    }
                  }
                }}
              />

              {/* Feature: Disappearing messages TTL selector */}
              <select
                value={ttlSeconds}
                onChange={(e) => setTtlSeconds(Number(e.target.value))}
                className="text-xs bg-white hover:bg-gray-50 text-gray-700 rounded-lg px-2 py-2 border outline-none cursor-pointer"
                title="Disappearing messages timer"
              >
                <option value={0}>⏱️ Off</option>
                <option value={3600}>⏱️ 1 hour</option>
                <option value={86400}>⏱️ 1 day</option>
                <option value={604800}>⏱️ 1 week</option>
              </select>

              <input
                className="flex-1 bg-white rounded-lg px-4 py-2.5 outline-none border text-sm"
                placeholder={isConnected ? "Type a message" : "Offline — message will be queued"}
                value={messageText}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onBlur={() => activeConv && msg.sendTyping(activeConv, false)}
              />

              <button
                className="bg-whatsapp-green text-white rounded-full p-2.5 hover:bg-whatsapp-green-dark transition disabled:opacity-40"
                onClick={handleSend}
                disabled={!messageText.trim()}
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                </svg>
              </button>
            </div>
          </>
        )}
      </div>

      {/* ─── New Chat Modal ───────────────────────────────────────────── */}
      {showNewChat && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-2xl w-96 max-h-[70vh] overflow-hidden">
            <div className="px-5 py-4 border-b flex justify-between items-center">
              <h2 className="font-semibold text-lg">New conversation</h2>
              <button onClick={() => setShowNewChat(false)}>
                <svg className="w-6 h-6 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="overflow-y-auto max-h-80">
              {users
                .filter((u) => !msg.conversations.find((c) => c.userId === u.id))
                .map((u) => (
                  <div
                    key={u.id}
                    className="flex items-center px-5 py-3 cursor-pointer hover:bg-gray-50"
                    onClick={() => {
                      openConversation(u.id);
                      setShowNewChat(false);
                    }}
                  >
                    <UserAvatar username={u.username} size="sm" />
                    <span className="ml-3 font-medium">{u.username}</span>
                  </div>
                ))}
              {users.filter((u) => !msg.conversations.find((c) => c.userId === u.id)).length === 0 && (
                <p className="text-center text-gray-400 text-sm py-8">All users are in your conversations</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ─── Create Group Modal ───────────────────────────────────────── */}
      {showCreateGroup && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-2xl w-96 max-h-[80vh] overflow-hidden">
            <div className="px-5 py-4 border-b flex justify-between items-center">
              <h2 className="font-semibold text-lg">New Group</h2>
              <button onClick={() => setShowCreateGroup(false)}>
                <svg className="w-6 h-6 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="px-5 py-3">
              <input
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-whatsapp-green"
                placeholder="Group name"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                maxLength={50}
              />
            </div>
            <div className="px-5 py-2 border-t">
              <p className="text-xs text-gray-500 uppercase font-medium mb-2">Add members</p>
              <div className="max-h-40 overflow-y-auto space-y-1">
                {users.map((u) => (
                  <label
                    key={u.id}
                    className="flex items-center gap-3 py-2 cursor-pointer hover:bg-gray-50 rounded px-2"
                  >
                    <input
                      type="checkbox"
                      checked={!!groupMembers.find((m) => m.id === u.id)}
                      onChange={() => toggleGroupMember(u)}
                      className="accent-whatsapp-green"
                    />
                    <UserAvatar username={u.username} size="sm" />
                    <span className="text-sm font-medium">{u.username}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="px-5 py-3 border-t">
              <button
                className="w-full bg-whatsapp-green text-white font-semibold py-2 rounded-lg hover:bg-whatsapp-green-dark disabled:opacity-50"
                onClick={handleCreateGroup}
                disabled={!groupName.trim() || groupMembers.length === 0}
              >
                Create Group ({groupMembers.length} member{groupMembers.length !== 1 ? "s" : ""})
              </button>
            </div>
          </div>
        </div>
      )}
      {/* ─── Group Members Modal ─────────────────────────────────────── */}
      {showGroupModal && activeGroup && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-2xl w-96 max-h-[80vh] flex flex-col overflow-hidden">
            <div className="px-5 py-4 border-b flex justify-between items-center">
              <div>
                <h2 className="font-semibold text-lg">{activeGroup.username}</h2>
                <p className="text-xs text-gray-500">
                  {activeGroup.memberIds?.length || 0} members · Created by {activeGroup.createdBy === auth.userId ? "You" : (users.find(u => u.id === activeGroup.createdBy)?.username || "Admin")}
                </p>
              </div>
              <button onClick={() => setShowGroupModal(false)}>
                <svg className="w-6 h-6 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-4 overflow-y-auto flex-1 divide-y">
              {(activeGroup.memberIds || []).map((mId) => {
                const memberUser = users.find((u) => u.id === mId) || (mId === auth.userId ? { id: auth.userId, username: `${auth.username} (You)` } : { id: mId, username: "Unknown user" });
                const isCreator = activeGroup.createdBy === auth.userId;
                const canRemove = isCreator && mId !== auth.userId;
                return (
                  <div key={mId} className="flex items-center justify-between py-2">
                    <div className="flex items-center gap-3">
                      <UserAvatar username={memberUser.username} size="sm" />
                      <span className="text-sm font-medium text-gray-800">{memberUser.username}</span>
                    </div>
                    {canRemove && (
                      <button
                        onClick={() => {
                          if (window.confirm(`Remove ${memberUser.username} from group?`)) {
                            ws.send("remove_member", { group_id: activeConv, target_user_id: mId });
                          }
                        }}
                        className="text-red-500 hover:text-red-700 hover:bg-red-50 p-1 rounded-full text-xs font-semibold px-2"
                        title="Remove member"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ─── QR Scanner Modal ────────────────────────────────────────── */}
      {showQR && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-2xl w-96 overflow-hidden">
            <div className="px-5 py-4 border-b flex justify-between items-center">
              <h2 className="font-semibold text-lg">Scan QR Code</h2>
              <button onClick={() => setShowQR(false)}>
                <svg className="w-6 h-6 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-4">
              <QRScanner onScan={handleTrustQR} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
