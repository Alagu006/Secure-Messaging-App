import { useState, useCallback, useRef, useEffect } from "react";
import { cacheMessages, getCachedMessages } from "../utils/messageCache";
import { getApiUrl } from "../utils/serverConfig";

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
      // Feature 4: Check group_id first so group messages are filed under the group's conversation ID
      const isGroup = !!data.group_id;
      const convId = isGroup ? data.group_id : (isFromMe ? data.recipient_id : senderId);
      const otherId = convId;

      // Handle group session key distribution
      if (data.message_type === "group_key_bundle") {
        try {
          let sender = userMap.current[senderId];
          if (!sender?.public_key) {
            const token = extractJwt();
            if (token) {
              const uRes = await fetch(`${getApiUrl()}/auth/users`, {
                headers: { Authorization: `Bearer ${token}` },
              });
              if (uRes.ok) {
                const uData = await uRes.json();
                uData.forEach((u) => { userMap.current[u.id] = u; });
                sender = userMap.current[senderId];
              }
            }
          }
          if (sender?.public_key && encryption?.unwrapAndStoreGroupKey) {
            await encryption.unwrapAndStoreGroupKey(
              data.group_id,
              sender.public_key,
              data.ciphertext,
              currentUserId
            );
          }
        } catch (err) {
          console.error("Failed to unwrap group key bundle:", err);
        }
        return; // Key bundles are protocol messages, not visible text
      }

      // Attempt decryption
      let plaintext = "";
      let decryptFailed = false;
      if (isGroup) {
        if (encryption && data.ciphertext && !data.is_deleted) {
          try {
            const { iv, ciphertext } = unbundle(data.ciphertext);
            plaintext = await encryption.decryptGroup(data.group_id, iv, ciphertext);
          } catch {
            decryptFailed = true;
            plaintext = "🔒 Encrypted group message";
          }
        }
      } else {
        const otherUser = userMap.current[otherId];
        if (otherUser && encryption && data.ciphertext && !data.is_deleted) {
          try {
            const { iv, ciphertext } = unbundle(data.ciphertext);
            if (!otherUser.public_key) throw new Error('Recipient public key not found');
            plaintext = await encryption.decrypt(otherUser.public_key, iv, ciphertext);
          } catch {
            decryptFailed = true;
            plaintext = "🔒 Encrypted message";
          }
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
        groupId: data.group_id || null,
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
      const prev = messagesByConvRef.current[convId] || [];
      const updated = [...prev, msg];
      messagesByConvRef.current[convId] = updated;
      setMessagesByConv({ ...messagesByConvRef.current });
      cacheMessages(convId, [msg]);

      // Update conversation list
      updateConversationList(convId, msg, isFromMe, isGroup);

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
      if (data.key_bundle && encryption?.unwrapAndStoreGroupKey) {
        const creator = userMap.current[data.created_by];
        if (creator?.public_key) {
          encryption.unwrapAndStoreGroupKey(
            groupConvId,
            creator.public_key,
            data.key_bundle,
            currentUserId
          ).catch((err) => console.error("Failed to unwrap key bundle on group_created:", err));
        }
      }

      setConversations((prev) => {
        if (prev.find((c) => c.userId === groupConvId)) return prev;
        return [...prev, {
          userId: groupConvId,
          username: data.name,
          isGroup: true,
          memberIds: data.members,
          createdBy: data.created_by,
          lastMessage: "Group created",
          lastTime: new Date().toISOString(),
          isOnline: false,
        }];
      });
    };

    const handleMemberLeft = (data) => {
      const { group_id, user_id } = data;
      if (user_id === currentUserId) {
        setConversations((prev) => prev.filter((c) => c.userId !== group_id));
      } else {
        setConversations((prev) =>
          prev.map((c) =>
            c.userId === group_id && c.memberIds
              ? { ...c, memberIds: c.memberIds.filter((id) => id !== user_id) }
              : c
          )
        );
      }
    };

    const handleMemberRemoved = (data) => {
      const { group_id, user_id } = data;
      if (user_id === currentUserId) {
        setConversations((prev) => prev.filter((c) => c.userId !== group_id));
      } else {
        setConversations((prev) =>
          prev.map((c) =>
            c.userId === group_id && c.memberIds
              ? { ...c, memberIds: c.memberIds.filter((id) => id !== user_id) }
              : c
          )
        );
      }
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
    ws.on("member_left", handleMemberLeft);
    ws.on("member_removed", handleMemberRemoved);

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
      ws.off("member_left");
      ws.off("member_removed");
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
      const isGroup = conversations.find((c) => c.userId === otherUserId)?.isGroup || false;
      const apiBase = getApiUrl();
      let url = isGroup
        ? `${apiBase}/messages/group/${otherUserId}?limit=50`
        : `${apiBase}/messages/${otherUserId}?limit=50`;
      if (beforeId) url += `&before_id=${beforeId}`;
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) return;
      const msgs = await resp.json();

      // Track whether there are more pages
      hasMoreRef.current[otherUserId] = msgs.length >= 50;

      // If group, ensure group session key is loaded before decrypting messages
      if (isGroup && encryption?.unwrapAndStoreGroupKey) {
        let groupKey = await encryption.getGroupKey?.(otherUserId);
        if (!groupKey) {
          for (const m of msgs) {
            if (m.message_type === "group_key_bundle") {
              try {
                let sender = userMap.current[m.sender_id];
                if (!sender?.public_key) {
                  const uRes = await fetch(`${apiBase}/auth/users`, {
                    headers: { Authorization: `Bearer ${token}` },
                  });
                  if (uRes.ok) {
                    const uList = await uRes.json();
                    uList.forEach((u) => { userMap.current[u.id] = u; });
                    sender = userMap.current[m.sender_id];
                  }
                }
                if (sender?.public_key) {
                  await encryption.unwrapAndStoreGroupKey(
                    otherUserId,
                    sender.public_key,
                    m.ciphertext,
                    currentUserId
                  );
                  groupKey = await encryption.getGroupKey?.(otherUserId);
                  break;
                }
              } catch (err) {
                console.error("Failed to unwrap group key bundle from history:", err);
              }
            }
          }
        }

        // If still no group key, fetch from dedicated key-bundle endpoint
        if (!groupKey) {
          try {
            const kbRes = await fetch(`${apiBase}/messages/group/${otherUserId}/key-bundle`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (kbRes.ok) {
              const kbData = await kbRes.json();
              let sender = userMap.current[kbData.sender_id];
              if (!sender?.public_key) {
                const uRes = await fetch(`${apiBase}/auth/users`, {
                  headers: { Authorization: `Bearer ${token}` },
                });
                if (uRes.ok) {
                  const uList = await uRes.json();
                  uList.forEach((u) => { userMap.current[u.id] = u; });
                  sender = userMap.current[kbData.sender_id];
                }
              }
              if (sender?.public_key) {
                await encryption.unwrapAndStoreGroupKey(
                  otherUserId,
                  sender.public_key,
                  kbData.key_bundle,
                  currentUserId
                );
              }
            }
          } catch (err) {
            console.warn("Failed to fetch dedicated group key bundle:", err);
          }
        }
      }

      const decrypted = [];
      for (const m of msgs) {
        // Skip group key bundles from visible messages list
        if (m.message_type === "group_key_bundle") continue;

        let plaintext = "";
        let decryptFailed = false;

        if (isGroup) {
          if (encryption && m.ciphertext && !m.is_deleted) {
            try {
              const { iv, ciphertext } = unbundle(m.ciphertext);
              plaintext = await encryption.decryptGroup(otherUserId, iv, ciphertext);
            } catch {
              decryptFailed = true;
              plaintext = "🔒 Encrypted group message";
            }
          }
        } else {
          let otherUser = userMap.current[otherUserId];
          if (!otherUser) {
            try {
              const uRes = await fetch(`${apiBase}/auth/users`, {
                headers: { Authorization: `Bearer ${token}` },
              });
              if (uRes.ok) {
                const uList = await uRes.json();
                uList.forEach((u) => { userMap.current[u.id] = u; });
                otherUser = userMap.current[otherUserId];
              }
            } catch {}
          }
          if (otherUser && encryption && m.ciphertext && !m.is_deleted) {
            try {
              const { iv, ciphertext } = unbundle(m.ciphertext);
              plaintext = await encryption.decrypt(otherUser.public_key, iv, ciphertext);
            } catch {
              decryptFailed = true;
              plaintext = "🔒 Encrypted message";
            }
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
          groupId: m.group_id || null,
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
      const existing = messagesByConvRef.current[convId] || [];
      const existingMap = new Map(existing.map((e) => [e.id, e]));
      let hasChanges = false;

      for (const d of decrypted) {
        const prev = existingMap.get(d.id);
        if (!prev) {
          existingMap.set(d.id, d);
          hasChanges = true;
        } else if (prev.decryptFailed && !d.decryptFailed) {
          existingMap.set(d.id, d);
          hasChanges = true;
        }
      }

      if (hasChanges || !beforeId) {
        const merged = Array.from(existingMap.values()).sort(
          (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
        );
        messagesByConvRef.current[convId] = merged;
        setMessagesByConv({ ...messagesByConvRef.current });
        cacheMessages(convId, merged);
      }
    } catch {
      // silently fail
    }
  }

  function updateConversationList(convId, msg, isFromMe, isGroup = false) {
    setConversations((prev) => {
      const existing = prev.find((c) => c.userId === convId);
      if (isGroup || existing?.isGroup) {
        if (!existing) return prev;
        const entry = {
          ...existing,
          lastMessage: msg.plaintext || (msg.isDeleted ? "Message deleted" : ""),
          lastTime: msg.createdAt,
        };
        return prev.map((c) => (c.userId === convId ? entry : c));
      }

      const user = userMap.current[convId];
      if (!user) return prev;
      const entry = {
        userId: convId,
        username: user.username,
        publicKeyB64: user.public_key,
        lastMessage: msg.plaintext || (msg.isDeleted ? "Message deleted" : ""),
        lastTime: msg.createdAt,
        isOnline: onlineUsers.has(convId),
      };
      if (existing) {
        return prev.map((c) => (c.userId === convId ? entry : c));
      }
      return [...prev, entry];
    });
  }

  const sendMessage = useCallback(
    async (targetId, recipientPublicKey, text, replyToId = null, messageType = "text", fileMeta = null, ttlSeconds = null, isGroup = false) => {
      if (!encryption || !ws) return;
      try {
        let payload = text;
        // For file messages, encrypt a JSON metadata blob instead of display text
        if (fileMeta) {
          payload = JSON.stringify({ type: "file", file_id: fileMeta.fileId, name: fileMeta.name, mime: fileMeta.mime, size: fileMeta.size });
        }

        let bundledCiphertext;
        if (isGroup) {
          const { iv, ciphertext } = await encryption.encryptGroup(targetId, payload);
          bundledCiphertext = bundle(iv, ciphertext);
        } else {
          const { iv, ciphertext } = await encryption.encrypt(
            recipientPublicKey,
            payload
          );
          bundledCiphertext = bundle(iv, ciphertext);
        }

        const msgPayload = {
          ciphertext: bundledCiphertext,
          message_type: messageType,
          reply_to_id: replyToId,
        };
        if (isGroup) {
          msgPayload.group_id = targetId;
        } else {
          msgPayload.recipient_id = targetId;
        }
        // Feature: Include TTL seconds for disappearing messages
        if (ttlSeconds && ttlSeconds > 0) {
          msgPayload.ttl_seconds = ttlSeconds;
        }
        ws.send("send_message", msgPayload);
      } catch (err) {
        console.error("Encryption or send failed:", err);
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
        const isGroup = conversations.find((c) => c.userId === recipientId)?.isGroup || false;
        let bundledCiphertext;
        if (isGroup) {
          const { iv, ciphertext } = await encryption.encryptGroup(recipientId, newText);
          bundledCiphertext = bundle(iv, ciphertext);
        } else {
          const { iv, ciphertext } = await encryption.encrypt(
            recipientPublicKey,
            newText
          );
          bundledCiphertext = bundle(iv, ciphertext);
        }
        ws.send("message_edit", {
          message_id: messageId,
          ciphertext: bundledCiphertext,
        });
      } catch (err) {
        console.error("Re-encryption failed:", err);
      }
    },
    [encryption, ws, conversations]
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

  // Feature: Client-side search across conversation history
  const searchMessages = useCallback(
    async (query, convId = null) => {
      if (!query || !query.trim()) return [];
      const q = query.trim().toLowerCase();

      const candidateMap = new Map();
      if (convId) {
        const inMemory = messagesByConvRef.current[convId] || [];
        inMemory.forEach((m) => { if (m && m.id) candidateMap.set(m.id, m); });
        try {
          const cached = await getCachedMessages(convId);
          cached.forEach((m) => { if (m && m.id && !candidateMap.has(m.id)) candidateMap.set(m.id, m); });
        } catch {}
      } else {
        Object.values(messagesByConvRef.current).forEach((msgs) => {
          (msgs || []).forEach((m) => { if (m && m.id) candidateMap.set(m.id, m); });
        });
        for (const c of conversations) {
          try {
            const cached = await getCachedMessages(c.userId);
            cached.forEach((m) => { if (m && m.id && !candidateMap.has(m.id)) candidateMap.set(m.id, m); });
          } catch {}
        }
      }

      const results = [];
      for (const m of candidateMap.values()) {
        const sender = userMap.current[m.senderId];
        const senderName = (m.senderId === currentUserId ? "you" : sender?.username || "").toLowerCase();
        const plaintext = (m.plaintext || "").toLowerCase();
        const dateStr = m.createdAt ? new Date(m.createdAt).toLocaleDateString().toLowerCase() : "";
        const timeStr = m.createdAt ? new Date(m.createdAt).toLocaleTimeString().toLowerCase() : "";

        if (plaintext.includes(q) || senderName.includes(q) || dateStr.includes(q) || timeStr.includes(q)) {
          results.push({
            ...m,
            senderName: m.senderId === currentUserId ? "You" : sender?.username || "Unknown",
          });
        }
      }
      return results;
    },
    [conversations, currentUserId]
  );

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
    searchMessages,
    bundle,
    unbundle,
  };
}
