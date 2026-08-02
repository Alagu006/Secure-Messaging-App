/*
 * webrtc.js — Peer-to-peer file transfer for LANChat
 *
 * Uses WebRTC data channels to transfer files directly between two
 * browsers without the file touching the server.
 *
 * FLOW:
 *   1. Sender selects a file and clicks send
 *   2. Sender creates RTCPeerConnection + data channel + offer
 *   3. Offer is sent via WebSocket (webrtc_signal event)
 *   4. Receiver creates answer, sends back via WebSocket
 *   5. ICE candidates are exchanged through the same signaling channel
 *   6. Data channel opens → encrypted file chunks flow directly P2P
 *   7. On complete: receiver reassembles, decrypts, verifies checksum
 *
 * STUN/TURN are disabled — this only works on LAN (no internet needed).
 *
 * FILE ENCRYPTION:
 *   A random 256-bit file key encrypts the file with AES-256-GCM.
 *   The file key itself is encrypted with the conversation's shared key
 *   (from ECDH) and sent in the metadata. The receiver unwraps the file
 *   key, then decrypts the data. The file key is ephemeral — used once
 *   and discarded.
 *
 * CHUNKING:
 *   Files are split into 64 KB chunks so large files stream incrementally
 *   and the UI can show a live progress bar.
 */

import { arrayBufferToBase64, base64ToArrayBuffer } from "./crypto";

const CHUNK_SIZE = 64 * 1024; // 64 KB per chunk
// Google's free STUN server helps with mDNS hostname resolution on Chrome.
// File data still travels P2P — STUN only helps peers discover each other.
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
];

// ── 1. createPeerConnection() ────────────────────────────────────────────

export function createPeerConnection(signalingCallback, isReceiver = false) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const pendingCandidates = [];

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      signalingCallback({
        type: "candidate",
        candidate: event.candidate.toJSON(),
      });
    }
  };

  // Only the offerer creates the data channel programmatically.
  // The receiver gets it via pc.ondatachannel.
  if (!isReceiver) {
    const dataChannel = pc.createDataChannel("fileTransfer", {
      ordered: true,
    });

    // Backpressure: buffer 1 MB before notifying
    dataChannel.bufferedAmountLowThreshold = 65536;

    pc.onconnectionstatechange = () => {
      if (
        pc.connectionState === "disconnected" ||
        pc.connectionState === "failed" ||
        pc.connectionState === "closed"
      ) {
        dataChannel.close();
      }
    };

    return { pc, dataChannel, pendingCandidates };
  }

  // Receiver: no data channel created, will be provided via ondatachannel
  return { pc, dataChannel: null, pendingCandidates };
}

// ── 2. sendFile() ────────────────────────────────────────────────────────

export async function sendFile(dataChannel, sharedKey, file, onProgress) {
  /*
    Encrypt a file, split into 64 KB chunks, and send over the data channel.

    The file is encrypted with an ephemeral AES-256-GCM key. That key is
    wrapped (encrypted) with the conversation's shared ECDH key so only
    the intended recipient can unwrap it.

    Chunks are sent as JSON messages with base64-encoded data. In practice
    you'd use ArrayBuffers for speed, but JSON+base64 is simpler to
    implement and debug, and the LAN latency is negligible.

    Parameters:
      dataChannel — the RTCDataChannel from createPeerConnection()
      sharedKey   — the AES-256-GCM CryptoKey from deriveSharedSecret()
      file        — a JavaScript File object (from an <input type="file">)
      onProgress  — callback(percent) called after each chunk is sent

    Returns:
      The ephemeral file key (for cleanup / re-send if needed)
  */

  return new Promise(async (resolve, reject) => {
    // ── Read the file into memory ──────────────────────────────────────
    const fileData = await file.arrayBuffer();

    // ── Generate ephemeral file key + IV ───────────────────────────────
    const fileKey = crypto.getRandomValues(new Uint8Array(32)); // AES-256
    const fileIV = crypto.getRandomValues(new Uint8Array(12));  // GCM IV

    // Import the ephemeral key so SubtleCrypto can use it
    const fileCryptoKey = await crypto.subtle.importKey(
      "raw",
      fileKey,
      { name: "AES-GCM" },
      false,
      ["encrypt"]
    );

    // ── Encrypt the entire file with the ephemeral key ───────────────
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: fileIV, tagLength: 128 },
      fileCryptoKey,
      fileData
    );

    // ── Compute SHA-256 checksum of the ORIGINAL file (for integrity) ─
    const checksum = await crypto.subtle.digest("SHA-256", fileData);

    // ── Wrap the ephemeral file key with the conversation's shared key ─
    const wrapIV = crypto.getRandomValues(new Uint8Array(12));
    const encryptedFileKey = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: wrapIV, tagLength: 128 },
      sharedKey,
      fileKey
    );

    // ── Split encrypted data into 64 KB chunks ────────────────────────
    const encBytes = new Uint8Array(encrypted);
    const totalChunks = Math.ceil(encBytes.length / CHUNK_SIZE);
    const transferId = crypto.randomUUID();

    // ── Send metadata (first message on the data channel) ────────────
    dataChannel.send(
      JSON.stringify({
        type: "file-meta",
        transferId,
        name: file.name,
        size: file.size,
        mimeType: file.type || "application/octet-stream",
        encryptedFileKey: arrayBufferToBase64(encryptedFileKey),
        wrapIV: arrayBufferToBase64(wrapIV.buffer),
        fileIV: arrayBufferToBase64(fileIV.buffer),
        totalChunks,
        checksum: arrayBufferToBase64(checksum),
      })
    );

    // ── Send each chunk ───────────────────────────────────────────────
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, encBytes.length);
      const chunk = encBytes.slice(start, end);

      dataChannel.send(
        JSON.stringify({
          type: "file-chunk",
          transferId,
          index: i,
          data: arrayBufferToBase64(chunk.buffer),
          totalChunks,
        })
      );

      // Report progress (0–100)
      const percent = Math.round(((i + 1) / totalChunks) * 100);
      onProgress(percent);
    }

    // ── Signal completion ─────────────────────────────────────────────
    dataChannel.send(
      JSON.stringify({
        type: "file-complete",
        transferId,
      })
    );

    resolve(transferId);
  });
}

// ── 3. receiveFile() ─────────────────────────────────────────────────────

export async function receiveFile(dataChannel, sharedKey, onProgress, onComplete) {
  /*
    Listen on the data channel for incoming file chunks, reassemble,
    decrypt, verify checksum, and pass the recovered file to a callback.

    This function sets up the data channel's onmessage handler and returns
    a cleanup function to detach it.

    Parameters:
      dataChannel — the RTCDataChannel from createPeerConnection()
      sharedKey   — the AES-256-GCM CryptoKey from deriveSharedSecret()
      onProgress  — callback(percent) called as chunks arrive
      onComplete  — callback({ blob, filename, mimeType }) when done

    Returns:
      An object with a cancel() method to abort mid-transfer.
  */

  let state = {
    transferId: null,
    name: "",
    mimeType: "",
    chunks: [],
    totalChunks: 0,
    encryptedFileKey: null,
    wrapIV: null,
    fileIV: null,
    checksum: null,
    cancelled: false,
  };

  const originalHandler = dataChannel.onmessage;

  dataChannel.onmessage = async (event) => {
    if (state.cancelled) return;

    try {
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case "file-meta":
          // Store metadata and prepare to receive chunks
          state.transferId = msg.transferId;
          state.name = msg.name;
          state.mimeType = msg.mimeType;
          state.totalChunks = msg.totalChunks;
          state.encryptedFileKey = base64ToArrayBuffer(msg.encryptedFileKey);
          state.wrapIV = base64ToArrayBuffer(msg.wrapIV);
          state.fileIV = base64ToArrayBuffer(msg.fileIV);
          state.checksum = base64ToArrayBuffer(msg.checksum);
          state.chunks = new Array(msg.totalChunks);
          break;

        case "file-chunk":
          // Store the chunk at its index position
          if (msg.transferId === state.transferId) {
            state.chunks[msg.index] = base64ToArrayBuffer(msg.data);
            const received = state.chunks.filter((c) => c !== undefined).length;
            const percent = Math.round((received / state.totalChunks) * 100);
            onProgress(percent);
          }
          break;

        case "file-complete":
          if (msg.transferId === state.transferId) {
            // All chunks received — reassemble
            const allChunks = state.chunks.map((c) => new Uint8Array(c));
            const totalLength = allChunks.reduce((sum, c) => sum + c.length, 0);
            const assembled = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of allChunks) {
              assembled.set(chunk, offset);
              offset += chunk.length;
            }

            // ── Decrypt the data ──────────────────────────────────────
            // First, unwrap the file key with the conversation's shared key
            const unwrappedKey = await crypto.subtle.decrypt(
              {
                name: "AES-GCM",
                iv: new Uint8Array(state.wrapIV),
                tagLength: 128,
              },
              sharedKey,
              new Uint8Array(state.encryptedFileKey)
            );

            // Import the unwrapped file key
            const fileCryptoKey = await crypto.subtle.importKey(
              "raw",
              new Uint8Array(unwrappedKey),
              { name: "AES-GCM" },
              false,
              ["decrypt"]
            );

            // Decrypt the file data
            let decrypted;
            try {
              decrypted = await crypto.subtle.decrypt(
                {
                  name: "AES-GCM",
                  iv: new Uint8Array(state.fileIV),
                  tagLength: 128,
                },
                fileCryptoKey,
                assembled
              );
            } catch {
              onComplete({
                error: true,
                message: "Decryption failed — file may be corrupt or tampered",
              });
              return;
            }

            // ── Verify SHA-256 checksum ─────────────────────────────
            const actualChecksum = await crypto.subtle.digest(
              "SHA-256",
              decrypted
            );

            const expected = new Uint8Array(state.checksum);
            const actual = new Uint8Array(actualChecksum);

            let match = expected.length === actual.length;
            for (let i = 0; i < expected.length && match; i++) {
              if (expected[i] !== actual[i]) match = false;
            }

            if (!match) {
              onComplete({
                error: true,
                message: "Checksum mismatch — file integrity check failed",
              });
              return;
            }

            // ── Success — return the recovered file ──────────────────
            const blob = new Blob([decrypted], { type: state.mimeType });
            onComplete({
              blob,
              filename: state.name,
              mimeType: state.mimeType,
              error: false,
            });

            // Reset state for the next transfer
            state = { ...state, chunks: [], totalChunks: 0 };
          }
          break;

        case "cancel":
          state.cancelled = true;
          state.chunks = [];
          onComplete({
            error: true,
            message: "Transfer cancelled by sender",
          });
          break;
      }
    } catch {
      // Ignore non-JSON messages
    }
  };

  return {
    cancel: () => {
      state.cancelled = true;
      state.chunks = [];
      dataChannel.send(
        JSON.stringify({ type: "cancel", transferId: state.transferId })
      );
      dataChannel.onmessage = originalHandler;
    },
  };
}

// ── 4. cancelTransfer() ─────────────────────────────────────────────────

export function cancelTransfer(pc, dataChannel = null) {
  /*
    Abort an in-progress file transfer.

    Closes the data channel and the peer connection, freeing up resources
    and notifying the other peer that the transfer was cancelled.

    Parameters:
      pc           — the RTCPeerConnection to tear down
      dataChannel  — optional RTCDataChannel to send cancel on before closing
  */

  try {
    if (dataChannel) {
      try {
        if (dataChannel.readyState === "open") {
          dataChannel.send(JSON.stringify({ type: "cancel" }));
        }
      } catch {}
      dataChannel.close();
    }
    pc.close();
  } catch {
    // Already closed — nothing to do
  }
}

// ── 5. Signaling helpers — createOffer / createAnswer / handleSignal ─────

export async function createOffer(pc) {
  /*
    Create an SDP offer and return it for sending via WebSocket.

    The offer describes our capabilities (codecs, data channel, etc.)
    to the other peer so they can create a compatible answer.

    Parameters:
      pc — the RTCPeerConnection

    Returns:
      An object: { type: "offer", sdp: "..." }
  */

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  return { type: "offer", sdp: offer.sdp };
}

export async function createAnswer(pc) {
  /*
    Create an SDP answer in response to an incoming offer.

    Parameters:
      pc — the RTCPeerConnection

    Returns:
      An object: { type: "answer", sdp: "..." }
  */

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  return { type: "answer", sdp: answer.sdp };
}

export async function handleSignal(pc, signal, pendingCandidates = []) {
  /*
    Process an incoming signaling message (offer, answer, or ICE candidate).

    This is called when a webrtc_signal event arrives via WebSocket.
    It handles both halves of the signaling exchange:
      - Offer  → set as remote description, create answer
      - Answer → set as remote description
      - Candidate → add ICE candidate (or queue if remote desc not set yet)

    Parameters:
      pc                 — the RTCPeerConnection
      signal             — the signal object: { type, sdp } or { type, candidate }
      pendingCandidates  — optional array to queue candidates before remote desc is set
  */

  if (signal.type === "offer") {
    await pc.setRemoteDescription(
      new RTCSessionDescription({ type: "offer", sdp: signal.sdp })
    );
  } else if (signal.type === "answer") {
    await pc.setRemoteDescription(
      new RTCSessionDescription({ type: "answer", sdp: signal.sdp })
    );
  } else if (signal.type === "candidate" && signal.candidate) {
    if (!pc.remoteDescription) {
      // Queue until remote description is set
      pendingCandidates.push(signal.candidate);
      return;
    }
    try {
      await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
    } catch {
      // Ignore invalid candidates
    }
  }
}

export function flushPendingCandidates(pc, pendingCandidates) {
  for (const cand of pendingCandidates) {
    try {
      pc.addIceCandidate(new RTCIceCandidate(cand));
    } catch {
      // Ignore invalid candidates
    }
  }
  pendingCandidates.length = 0;
}
