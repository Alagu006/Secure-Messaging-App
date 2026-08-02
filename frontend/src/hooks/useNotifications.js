/*
 * useNotifications.js — Browser push notifications for LANChat.
 *
 * Uses the browser's built-in Notification API (no external service).
 * Works entirely offline — notifications are local to this device.
 *
 * FLOW:
 *   1. On first login, we ask for permission (called by ChatPage).
 *   2. When a new_message event arrives and the tab is NOT focused,
 *      we show a browser notification with the sender's name.
 *   3. When the user clicks the notification, the tab is focused and
 *      the conversation is opened.
 *
 * IMPORTANT: We NEVER show message content in notifications — only the
 * sender name and "New message". This is a deliberate privacy choice.
 */

import { useCallback, useRef } from "react";

/**
 * Request notification permission from the browser.
 * Should be called once after login (e.g., in ChatPage mount).
 * Returns 'granted', 'denied', or 'default'.
 */
export async function requestNotificationPermission() {
  if (!("Notification" in window)) {
    return "unsupported";
  }
  if (Notification.permission === "granted") {
    return "granted";
  }
  if (Notification.permission === "denied") {
    return "denied";
  }
  // Ask the user for permission
  const result = await Notification.requestPermission();
  return result;
}

/**
 * React hook for managing notifications in a component.
 *
 * Returns:
 *   showNewMessageNotification(senderName, conversationId)
 *     — call this when a new message arrives from someone else
 */
export function useNotifications() {
  // Track the callback that opens a conversation when notification clicked
  const clickHandlerRef = useRef(null);

  /**
   * Register a callback that runs when the user clicks a notification.
   * The callback receives the conversationId (userId or groupId).
   */
  const onNotificationClick = useCallback((callback) => {
    clickHandlerRef.current = callback;
  }, []);

  /**
   * Show a browser notification for a new message.
   *
   * Only shows if:
   *   - Permission is granted
   *   - The tab is not focused (document.hidden)
   *
   * Parameters:
   *   senderName     — display name of the user who sent the message
   *   conversationId — userId or groupId to open on click
   */
  const showNewMessageNotification = useCallback((senderName, conversationId) => {
    if (!("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    // Don't notify if the tab is focused (user is already here)
    if (!document.hidden) return;
    // Avoid duplicate notifications in a short window
    // (handled by natural dedup since we create a new Notification each time)

    const notif = new Notification("LANChat", {
      body: `New message from ${senderName}`,
      icon: "/favicon.ico",   // will show a fallback if not present
      tag: `lanchat-${conversationId}`, // dedup per conversation
      silent: false,
    });

    // When the user clicks the notification, focus the tab and open the conversation
    notif.onclick = (event) => {
      event.preventDefault();
      // Focus the window/tab
      window.focus();
      // Call the registered click handler to open the right conversation
      if (clickHandlerRef.current) {
        clickHandlerRef.current(conversationId);
      }
      // Close the notification
      notif.close();
    };
  }, []);

  return {
    showNewMessageNotification,
    onNotificationClick,
  };
}
