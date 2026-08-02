import { useState } from "react";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

export default function ReactionPicker({ onSelect }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        className="bg-white rounded-full p-1 shadow hover:bg-gray-100"
        onClick={() => setOpen(!open)}
        title="React"
      >
        <svg className="w-3.5 h-3.5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-white rounded-full shadow-lg border px-2 py-1.5 flex gap-1.5">
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              className="text-lg hover:scale-125 transition"
              onClick={() => {
                onSelect(emoji);
                setOpen(false);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
