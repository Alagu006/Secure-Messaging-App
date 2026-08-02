import { useState, useCallback, useRef, useEffect } from "react";
import { cacheMessages, getCachedMessages } from "../utils/messageCache";

/*
  Network transport: since the server doesn't handle IV separately,
  we bundle IV and ciphertext together as  "iv_base64:ciphertext_base64"
  and split them on receive. This keeps the backend agnostic.
*/
function bundle(iv, ciphertext) {
  return iv + ":" + ciphertext;
}

function unbundle(combined) {
  const idx = combined.indexOf(":");
  if (idx === -1) return { iv: "", ciphertext: combined };
  return { iv: combined.slice(0, idx), ciphertext: combined.slice(idx + 1) };
}

function extractJwt() {
  try {
    const raw = sessionStorage.getItem("lanchat-session");
    if (raw) {
      const { jwt } = JSON.parse(raw);
      return jwt;
    }
  } catch {}
  return null;
}

export function useMessages(ws, encryption, currentUserId, users, keyPair) {
  const [conversations, setConversations] = useState([]);
  const [messagesByConv, setMessagesByConv] = useState({});
  const [onlineUsers, setOnlineUsers] = useState(new Set());
  const [typingUsers, setTypingUsers] = useState({});
  const [unreadCounts, setUnreadCounts] = useState({});
  const messagesByConvRef = useRef({});
  const unreadCountsRef = useRef({});
  const historyFetchedRef = useRef({});

  // Ensure encryption identity is set from auth keyPair
  useEffect(() => {
    if (keyPair && encryption && !encryption.identity) {
      encryption.setKeyPair(keyPair);
    }
  }, [keyPair, encryption]);

  // Build user lookup map
  const userMap = useRef({});
  useEffect(() => {
    const map = {};
    (users || []).forEach((u) => { map[u.id] = u; });
    userMap.current = map;
  }, [users]);

  // ── WebSocket event handlers ──────────────────────────────────────────

  useEffect(() => {
    if (!ws) return;

    const handleNewMessage = async (data) => {
      const senderId = data.sender_id;
      const isFromMe = senderId === currentUserId;
      const otherId = isFromMe ? data.recipient_id : senderId;

      // Attempt decryption
      let plaintext = "";
      let decryptFailed = false;
      const otherUser = userMap.current[otherId];
      if (otherUser && encryption) {
        try {
          const { iv, ciphertext } = unbundle(data.ciphertext);
          if (!otherUser.public_key) throw new Error('Recipient public key not found');
          plaintext = await encryption.decrypt(otherUser.public_key, iv, ciphertext);
        } catch {
          decryptFailed = true;
          plaintext = "🔒 Encrypted message";
        }
      }

      // Parse file metadata from decrypted plaintext if this is a file message
      let fileMeta = null;
      if ((data.message_type === "file" || plaintext?.startsWith('{"type":"file"'))) {
        try {
          const parsed = JSON.parse(plaintext);
          if (parsed.type === "file") {
            fileMeta = { fileId: parsed.file_id, name: parsed.name, mime: parsed.mime, size: parsed.size };
            plaintext = `📎 ${parsed.name}`;
          }
        } catch {}
      }

      const isDelivered = !isFromMe || data.delivered || !!data.isDelivered;
      const msg = {
        id: data.id,
        senderId,
        otherId,
        plaintext,
        ciphertext: data.ciphertext,
        messageType: data.message_type || "text",
        replyToId: data.reply_to_id || null,
        isDeleted: false,
        isEdited: false,
        reactions: [],
        createdAt: data.created_at || new Date().toISOString(),
        decryptFailed,
        isFromMe,
        isSent: isFromMe,
        isDelivered,
        isRead: false,
        fileMeta,
      };

      // Update messages
      const convId = otherId;
      const prev = messagesByConvRef.current[convId] || [];
      const updated = [...prev, msg];
      messagesByConvRef.current[convId] = updated;
      setMessagesByConv({ ...messagesByConvRef.current });
      cacheMessages(convId, [msg]);

      // Update conversation list
      updateConversationList(otherId, msg, isFromMe);

      // Unread count (only for received messages in non-active conv)
      if (!isFromMe) {
        const prevUnread = unreadCountsRef.current[convId] || 0;
        unreadCountsRef.current[convId] = prevUnread + 1;
        setUnreadCounts({ ...unreadCountsRef.current });
      }
    };

    const handleReadReceipt = (data) => {
      const convId = data.read_by;
      const msgs = messagesByConvRef.current[convId] || [];
      messagesByConvRef.current[convId] = msgs.map((m) =>
        m.senderId === currentUserId && !m.isRead
          ? { ...m, isRead: true, isDelivered: true }
          : m
      );
      setMessagesByConv({ ...messagesByConvRef.current });
    };

    const handleReactionUpdate = (data) => {
      const msgId = data.message_id;
      for (const convId of Object.keys(messagesByConvRef.current)) {
        const msgs = messagesByConvRef.current[convId];
        const idx = msgs.findIndex((m) => m.id === msgId);
        if (idx !== -1) {
          const reactions = [...(msgs[idx].reactions || [])];
          const existing = reactions.findIndex(
            (r) => r.userId === data.user_id && r.emoji === data.emoji
          );
          if (existing === -1) {
            reactions.push({
              id: data.id,
              userId: data.user_id,
              emoji: data.emoji,
            });
          }
          msgs[idx] = { ...msgs[idx], reactions };
          messagesByConvRef.current[convId] = [...msgs];
          setMessagesByConv({ ...messagesByConvRef.current });
          break;
        }
      }
    };

    const handleMessageEdited = (data) => {
      for (const convId of Object.keys(messagesByConvRef.current)) {
        const msgs = messagesByConvRef.current[convId];
        const idx = msgs.findIndex((m) => m.id === data.message_id);
        if (idx !== -1) {
          msgs[idx] = { ...msgs[idx], isEdited: true };
          messagesByConvRef.current[convId] = [...msgs];
          setMessagesByConv({ ...messagesByConvRef.current });
          break;
        }
      }
    };

    const handleMessageDeleted = (data) => {
      for (const convId of Object.keys(messagesByConvRef.current)) {
        const msgs = messagesByConvRef.current[convId];
        const idx = msgs.findIndex((m) => m.id === data.message_id);
        if (idx !== -1) {
          msgs[idx] = { ...msgs[idx], isDeleted: true, plaintext: "" };
          messagesByConvRef.current[convId] = [...msgs];
          setMessagesByConv({ ...messagesByConvRef.current });
          break;
        }
      }
    };

    const handleUserOnline = (data) => {
      setOnlineUsers((prev) => new Set([...prev, data.user_id]));
    };

    const handleOnlineUsers = (data) => {
      setOnlineUsers(new Set(data.users));
    };

    const handleUserOffline = (data) => {
      setOnlineUsers((prev) => {
        const next = new Set(prev);
        next.delete(data.user_id);
        return next;
      });
    };

    const handleTypingIndicator = (data) => {
      setTypingUsers((prev) => ({
        ...prev,
        [data.user_id]: data.is_typing,
      }));
      // Auto-clear typing after 5 seconds as a fallback
      if (data.is_typing) {
        setTimeout(() => {
          setTypingUsers((prev) => {
            if (prev[data.user_id]) {
              return { ...prev, [data.user_id]: false };
            }
            return prev;
          });
        }, 5000);
      }
    };

    const handleDeliveryReceipt = (data) => {
      const convId = data.delivered_to;
      const msgs = messagesByConvRef.current[convId] || [];
      messagesByConvRef.current[convId] = msgs.map((m) =>
        m.senderId === currentUserId && !m.isDelivered
          ? { ...m, isDelivered: true }
          : m
      );
      setMessagesByConv({ ...messagesByConvRef.current });
    };

    const handlePong = () => {};

    const handleGroupCreated = (data) => {
      // Add a conversation entry for this group
      const groupConvId = data.id;
      setConversations((prev) => {
        if (prev.find((c) => c.userId === groupConvId)) return prev;
        return [...prev, {
          userId: groupConvId,
          username: data.name,
          isGroup: true,
          memberIds: data.members,
          lastMessage: "Group created",
          lastTime: new Date().toISOString(),
          isOnline: false,
        }];
      });
    };

    ws.on("new_message", handleNewMessage);
    ws.on("read_receipt", handleReadReceipt);
    ws.on("delivery_receipt", handleDeliveryReceipt);
    ws.on("reaction_update", handleReactionUpdate);
    ws.on("message_edited", handleMessageEdited);
    ws.on("message_deleted", handleMessageDeleted);
    ws.on("user_online", handleUserOnline);
    ws.on("user_offline", handleUserOffline);
    ws.on("online_users", handleOnlineUsers);
    ws.on("typing_indicator", handleTypingIndicator);
    ws.on("pong", handlePong);
    ws.on("group_created", handleGroupCreated);

    return () => {
      ws.off("new_message");
      ws.off("read_receipt");
      ws.off("delivery_receipt");
      ws.off("reaction_update");
      ws.off("message_edited");
      ws.off("message_deleted");
      ws.off("user_online");
      ws.off("user_offline");
      ws.off("online_users");
      ws.off("typing_indicator");
      ws.off("pong");
      ws.off("group_created");
    };
  }, [ws, encryption, currentUserId, users]);

  // ── Helpers ─────────────────────────────────────────────────────────

  const hasMoreRef = useRef({});

  async function fetchHistory(otherUserId, beforeId = null) {
    const token = extractJwt();
    if (!token) return;

    // If no beforeId, this is the initial fetch — try cache first, then mark so we don't re-fetch
    if (!beforeId) {
      if (historyFetchedRef.current[otherUserId]) return;
      historyFetchedRef.current[otherUserId] = true;

      // Load cached messages for instant display
      const cached = await getCachedMessages(otherUserId);
      if (cached.length > 0 && (!messagesByConvRef.current[otherUserId] || messagesByConvRef.current[otherUserId].length === 0)) {
        messagesByConvRef.current[otherUserId] = cached;
        setMessagesByConv({ ...messagesByConvRef.current });
      }
    }

    try {
      let url = `/messages/${otherUserId}?limit=50`;
      if (beforeId) url += `&before_id=${beforeId}`;
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) return;
      const msgs = await resp.json();

      // Track whether there are more pages
      hasMoreRef.current[otherUserId] = msgs.length >= 50;

      const decrypted = [];
      for (const m of msgs) {
        let plaintext = "";
        let decryptFailed = false;
        const otherUser = userMap.current[otherUserId];
        if (otherUser && encryption && m.ciphertext && !m.is_deleted) {
          try {
            const { iv, ciphertext } = unbundle(m.ciphertext);
            plaintext = await encryption.decrypt(otherUser.public_key, iv, ciphertext);
          } catch {
            decryptFailed = true;
            plaintext = "🔒 Encrypted message";
          }
        }

        // Parse file metadata from decrypted plaintext
        let fileMeta = null;
        if ((m.message_type === "file" || plaintext?.startsWith('{"type":"file"'))) {
          try {
            const parsed = JSON.parse(plaintext);
            if (parsed.type === "file") {
              fileMeta = { fileId: parsed.file_id, name: parsed.name, mime: parsed.mime, size: parsed.size };
              plaintext = `📎 ${parsed.name}`;
            }
          } catch {}
        }

        const statuses = m.statuses || {};
        const otherStatus = statuses[otherUserId];
        decrypted.push({
          id: m.id,
          senderId: m.sender_id,
          otherId: otherUserId,
          plaintext: m.is_deleted ? "" : plaintext,
          ciphertext: m.ciphertext,
          messageType: m.message_type || "text",
          replyToId: m.reply_to_id || null,
          isDeleted: m.is_deleted,
          isEdited: false,
          reactions: [],
          createdAt: m.created_at || new Date().toISOString(),
          decryptFailed: m.is_deleted ? false : decryptFailed,
          isFromMe: m.sender_id === currentUserId,
          isSent: true,
          isDelivered: otherStatus === "delivered" || otherStatus === "read",
          isRead: otherStatus === "read",
          fileMeta,
        });
      }

      const convId = otherUserId;
      if (!beforeId) {
        // Initial fetch: prepend new messages to existing ones
        const existing = messagesByConvRef.current[convId] || [];
        const existingIds = new Set(existing.map((e) => e.id));
        const newMsgs = decrypted.filter((d) => !existingIds.has(d.id));
        if (newMsgs.length > 0) {
          messagesByConvRef.current[convId] = [...newMsgs, ...existing];
          setMessagesByConv({ ...messagesByConvRef.current });
          // Cache the merged result
          cacheMessages(convId, messagesByConvRef.current[convId]);
        }
      } else {
        // Pagination: prepend older messages
        const existing = messagesByConvRef.current[convId] || [];
        const existingIds = new Set(existing.map((e) => e.id));
        const newMsgs = decrypted.filter((d) => !existingIds.has(d.id));
        if (newMsgs.length > 0) {
          messagesByConvRef.current[convId] = [...newMsgs, ...existing];
          setMessagesByConv({ ...messagesByConvRef.current });
        }
      }
    } catch {
      // silently fail
    }
  }

  function updateConversationList(otherId, msg, isFromMe) {
    setConversations((prev) => {
      const user = userMap.current[otherId];
      if (!user) return prev;
      const existing = prev.find((c) => c.userId === otherId);
      const entry = {
        userId: otherId,
        username: user.username,
        publicKeyB64: user.public_key,
        lastMessage: msg.plaintext || (msg.isDeleted ? "Message deleted" : ""),
        lastTime: msg.createdAt,
        isOnline: onlineUsers.has(otherId),
      };
      if (existing) {
        return prev.map((c) => (c.userId === otherId ? entry : c));
      }
      return [...prev, entry];
    });
  }

  const sendMessage = useCallback(
    async (recipientId, recipientPublicKey, text, replyToId = null, messageType = "text", fileMeta = null) => {
      if (!encryption || !ws) return;
      try {
        let payload = text;
        // For file messages, encrypt a JSON metadata blob instead of display text
        if (fileMeta) {
          payload = JSON.stringify({ type: "file", file_id: fileMeta.fileId, name: fileMeta.name, mime: fileMeta.mime, size: fileMeta.size });
        }
        const { iv, ciphertext } = await encryption.encrypt(
          recipientPublicKey,
          payload
        );
        ws.send("send_message", {
          recipient_id: recipientId,
          ciphertext: bundle(iv, ciphertext),
          message_type: messageType,
          reply_to_id: replyToId,
        });
      } catch (err) {
        console.error("Encryption failed:", err);
      }
    },
    [encryption, ws]
  );

  const sendTyping = useCallback(
    (recipientId, isTyping) => {
      if (!ws) return;
      ws.send(isTyping ? "typing_start" : "typing_stop", {
        recipient_id: recipientId,
      });
    },
    [ws]
  );

  const markAsRead = useCallback(
    (messageId, otherUserId) => {
      if (!ws) return;
      // Optimistic update: mark messages as delivered and read immediately
      const msgs = messagesByConvRef.current[otherUserId] || [];
      let changed = false;
      messagesByConvRef.current[otherUserId] = msgs.map((m) => {
        if (m.senderId === currentUserId && (!m.isDelivered || !m.isRead)) {
          changed = true;
          return { ...m, isDelivered: true, isRead: true };
        }
        return m;
      });
      if (changed) {
        setMessagesByConv({ ...messagesByConvRef.current });
      }

      ws.send("message_read", { message_id: messageId, other_user_id: otherUserId });
      // Clear unread for this conversation
      if (unreadCountsRef.current[otherUserId]) {
        unreadCountsRef.current[otherUserId] = 0;
        setUnreadCounts({ ...unreadCountsRef.current });
      }
    },
    [ws, currentUserId]
  );

  const sendReaction = useCallback(
    (messageId, emoji) => {
      if (!ws) return;
      ws.send("message_reaction", { message_id: messageId, emoji });
    },
    [ws]
  );

  const editMessage = useCallback(
    async (messageId, recipientId, recipientPublicKey, newText) => {
      if (!encryption || !ws) return;
      try {
        const { iv, ciphertext } = await encryption.encrypt(
          recipientPublicKey,
          newText
        );
        ws.send("message_edit", {
          message_id: messageId,
          ciphertext: bundle(iv, ciphertext),
        });
      } catch (err) {
        console.error("Re-encryption failed:", err);
      }
    },
    [encryption, ws]
  );

  const deleteMessage = useCallback(
    (messageId) => {
      if (!ws) return;
      ws.send("message_delete", { message_id: messageId });
    },
    [ws]
  );

  const resetUnread = useCallback((convId) => {
    unreadCountsRef.current[convId] = 0;
    setUnreadCounts({ ...unreadCountsRef.current });
  }, []);

  // Re-sort conversations when online status changes
  useEffect(() => {
    setConversations((prev) =>
      prev.map((c) => ({
        ...c,
        isOnline: onlineUsers.has(c.userId),
      }))
    );
  }, [onlineUsers]);

  return {
    conversations,
    messagesByConv,
    onlineUsers,
    typingUsers,
    unreadCounts,
    sendMessage,
    sendTyping,
    markAsRead,
    sendReaction,
    editMessage,
    deleteMessage,
    resetUnread,
    fetchHistory,
    historyFetchedRef,
    hasMoreRef,
    bundle,
    unbundle,
  };
}
