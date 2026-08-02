import { useState, useMemo } from "react";
import ReadReceipt from "./ReadReceipt";
import ReactionPicker from "./ReactionPicker";
import { getApiUrl } from "../utils/serverConfig";

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

function fileUrl(fileId) {
  const token = extractJwt();
  return `${getApiUrl()}/files/${fileId}${token ? `?token=${token}` : ""}`;
}

export default function MessageBubble({
  message,
  isOwn,
  isSent,
  isDelivered,
  isRead,
  onReply,
  onReact,
  onEdit,
  onDelete,
  showReply,
  replyMessage,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(message.plaintext);

  const handleSaveEdit = () => {
    if (editText.trim() && editText !== message.plaintext) {
      onEdit(editText.trim());
    }
    setEditing(false);
  };

  const handleFileDownload = () => {
    if (!message.fileMeta?.fileId) return;
    const url = fileUrl(message.fileMeta.fileId);
    window.open(url, "_blank");
  };

  if (message.isDeleted) {
    return (
      <div className={`flex mb-2 ${isOwn ? "justify-end" : "justify-start"}`}>
        <div className="sent-bubble bg-gray-200 text-gray-500 italic text-sm">
          This message was deleted
        </div>
      </div>
    );
  }

  const fileMeta = message.fileMeta;

  return (
    <div className={`flex mb-2 ${isOwn ? "justify-end" : "justify-start"}`}>
      <div className="relative group max-w-[350px]">
        {/* Reply preview inside bubble */}
        {replyMessage && (
          <div className={`mb-1.5 pl-2 border-l-2 ${isOwn ? "border-whatsapp-green" : "border-whatsapp-teal"}`}>
            <p className="text-xs font-medium text-gray-500">Replying</p>
            <p className="text-xs text-gray-500 truncate max-w-[200px]">
              {replyMessage.plaintext || "Message"}
            </p>
          </div>
        )}

        {/* Bubble */}
        <div className={isOwn ? "sent-bubble" : "received-bubble"}>
          {/* File message with metadata */}
          {fileMeta ? (
            <div>
              {/* Image thumbnail */}
              {fileMeta.mime?.startsWith("image/") && (
                <div className="mb-1 -mx-3 -mt-2.5 rounded-t-lg overflow-hidden cursor-pointer" onClick={handleFileDownload}>
                  <img
                    src={fileUrl(fileMeta.fileId)}
                    alt={fileMeta.name}
                    className="max-w-full h-auto max-h-64 object-contain bg-gray-100"
                    onError={(e) => { e.target.style.display = "none"; }}
                  />
                </div>
              )}
              {/* File info row */}
              <div className="flex items-center gap-2 cursor-pointer" onClick={handleFileDownload}>
                <span className="text-xl">
                  {fileMeta.mime?.startsWith("image/") ? "🖼️"
                    : fileMeta.mime?.startsWith("video/") ? "🎬"
                    : fileMeta.mime?.startsWith("audio/") ? "🎵"
                    : "📎"}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{fileMeta.name}</p>
                  {fileMeta.size && (
                    <p className="text-[10px] text-gray-400">
                      {fileMeta.size > 1024 * 1024
                        ? `${(fileMeta.size / 1024 / 1024).toFixed(1)} MB`
                        : `${(fileMeta.size / 1024).toFixed(0)} KB`}
                    </p>
                  )}
                </div>
                <svg className="w-5 h-5 text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </div>
            </div>
          ) : editing ? (
            <div className="flex gap-2">
              <input
                className="flex-1 border rounded px-2 py-1 text-sm outline-none"
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSaveEdit()}
                autoFocus
              />
              <button className="text-whatsapp-green text-sm font-medium" onClick={handleSaveEdit}>Save</button>
              <button className="text-gray-400 text-sm" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          ) : (
            <p className="text-sm text-gray-900 break-words">{message.plaintext || "🔒 Encrypted"}</p>
          )}
          {!fileMeta && message.isEdited && <span className="text-xs text-gray-400 ml-1">(edited)</span>}

          {/* Time + receipt */}
          <div className="flex items-center justify-end gap-1 mt-0.5">
            <span className="text-[10px] text-gray-400">
              {message.createdAt
                ? new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                : ""}
            </span>
            {isOwn && <ReadReceipt isSent={isSent} isDelivered={isDelivered} isRead={isRead} />}
          </div>
        </div>

        {/* Reactions */}
        {message.reactions && message.reactions.length > 0 && (
          <div className={`flex gap-1 -mt-2 ${isOwn ? "justify-end" : "justify-start"}`}>
            {message.reactions.map((r, i) => (
              <span key={i} className="text-sm bg-white rounded-full px-1.5 shadow-sm border text-[10px] leading-none py-0.5">
                {r.emoji}
              </span>
            ))}
          </div>
        )}

        {/* Hover actions */}
        <div className={`absolute top-0 ${isOwn ? "left-0 -translate-x-full pr-1" : "right-0 translate-x-full pl-1"} hidden group-hover:flex gap-0.5`}>
          <button
            className="bg-white rounded-full p-1 shadow hover:bg-gray-100 text-xs"
            onClick={onReply}
            title="Reply"
          >
            <svg className="w-3.5 h-3.5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
            </svg>
          </button>
          <ReactionPicker onSelect={onReact} />
          {isOwn && !fileMeta && (
            <>
              <button
                className="bg-white rounded-full p-1 shadow hover:bg-gray-100"
                onClick={() => { setEditing(true); setEditText(message.plaintext); }}
                title="Edit"
              >
                <svg className="w-3.5 h-3.5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
              <button
                className="bg-white rounded-full p-1 shadow hover:bg-gray-100"
                onClick={onDelete}
                title="Delete"
              >
                <svg className="w-3.5 h-3.5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
