export default function TypingIndicator() {
  return (
    <div className="flex mb-2 justify-start">
      <div className="received-bubble flex items-center gap-1 py-3 px-4">
        <div className="typing-dot" />
        <div className="typing-dot" />
        <div className="typing-dot" />
      </div>
    </div>
  );
}
