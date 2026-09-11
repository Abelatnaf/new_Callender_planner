"use client";

import { useCallback, useId, useRef, useState } from "react";

export function Dropzone({
  title, hint, accept, busy, loaded, onFile,
}: {
  title: string;
  hint: string;
  accept: string;
  busy?: boolean;
  loaded?: string | null;
  onFile: (file: File) => void;
}) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();

  const take = useCallback((files: FileList | null) => {
    const f = files?.[0];
    if (f) onFile(f);
  }, [onFile]);

  return (
    <div
      className={`dropzone${over ? " is-over" : ""}${loaded ? " is-loaded" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); }}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); inputRef.current?.click(); } }}
      role="button"
      tabIndex={0}
      aria-describedby={id}
      aria-busy={busy}
    >
      <div className="dropzone__title">
        {busy ? <span className="working">Reading</span> : loaded ? "Loaded" : title}
      </div>
      <div className="dropzone__hint" id={id}>
        {loaded ? loaded : hint}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="sr-only"
        onChange={(e) => { take(e.target.files); e.target.value = ""; }}
      />
    </div>
  );
}
