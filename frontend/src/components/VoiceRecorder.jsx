import { useState, useRef, useEffect, useCallback } from "react";

export default function VoiceRecorder({ onSend }) {
  const [recording, setRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);
  const canvasRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const animationRef = useRef(null);

  const drawWaveform = useCallback(() => {
    const canvas = canvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser) return;
    const ctx = canvas.getContext("2d");
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const { width, height } = canvas;

    const draw = () => {
      animationRef.current = requestAnimationFrame(draw);
      analyser.getByteTimeDomainData(dataArray);
      ctx.clearRect(0, 0, width, height);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#25D366";
      ctx.beginPath();
      const sliceWidth = width / bufferLength;
      let x = 0;
      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = v * (height / 2) + height * 0.15;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += sliceWidth;
      }
      ctx.stroke();
    };
    draw();
  }, []);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Waveform
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      audioContextRef.current = audioCtx;
      analyserRef.current = analyser;
      drawWaveform();

      // MediaRecorder
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        cancelAnimationFrame(animationRef.current);
        audioContextRef.current?.close();
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        onSend(blob, duration);
        stream.getTracks().forEach((t) => t.stop());
        setDuration(0);
      };

      recorder.start();
      setRecording(true);

      let sec = 0;
      timerRef.current = setInterval(() => {
        sec++;
        setDuration(sec);
        if (sec >= 60) stopRecording();
      }, 1000);
    } catch {
      // Microphone access denied
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    clearInterval(timerRef.current);
    setRecording(false);
  };

  useEffect(() => {
    return () => {
      cancelAnimationFrame(animationRef.current);
      audioContextRef.current?.close();
      clearInterval(timerRef.current);
    };
  }, []);

  return (
    <div className="flex items-center gap-2">
      {recording && (
        <canvas
          ref={canvasRef}
          className="voice-waveform"
          width={120}
          height={32}
        />
      )}
      <button
        className={`p-1.5 rounded-full ${recording ? "bg-red-100 animate-pulse" : "hover:bg-gray-200"}`}
        onMouseDown={recording ? stopRecording : startRecording}
        onTouchStart={recording ? stopRecording : startRecording}
        title={recording ? "Release to stop recording" : "Hold to record voice"}
      >
        {recording ? (
          <span className="text-xs text-red-500 font-medium px-1">{duration}s</span>
        ) : (
          <svg className="w-6 h-6 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
          </svg>
        )}
      </button>
    </div>
  );
}
