git add .
git commit -m "Initial Commit (Cleaned)"
import { useRef } from "react";

export default function FileAttachment({ onAttach }) {
  const inputRef = useRef(null);

  const handleClick = () => {
    inputRef.current?.click();
  };

  const handleChange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      onAttach(file);
      e.target.value = "";
    }
  };

  return (
    <>
      <button onClick={handleClick} className="p-1.5 hover:bg-gray-200 rounded-full" title="Attach file">
        <svg className="w-6 h-6 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
        </svg>
      </button>
      <input ref={inputRef} type="file" className="hidden" onChange={handleChange}
        accept="image/*,video/*,audio/*,application/pdf,application/zip,application/x-zip-compressed,application/x-rar-compressed,application/x-7z-compressed,application/gzip,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,text/csv" />
    </>
  );
}
