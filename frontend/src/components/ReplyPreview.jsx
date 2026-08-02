export default function ReplyPreview({ message, onCancel }) {
  if (!message) return null;

  return (
    <div className="bg-whatsapp-sidebar-header px-4 py-2 flex items-center border-t">
      <div className="w-1 h-8 bg-whatsapp-green rounded-full mr-3 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-xs text-whatsapp-green font-medium">
          Replying to {message.senderUsername || "someone"}
        </p>
        <p className="text-sm text-gray-600 truncate">{message.plaintext || "Message"}</p>
      </div>
      <button onClick={onCancel} className="ml-2 flex-shrink-0">
        <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
