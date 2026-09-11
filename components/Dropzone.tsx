"use client";

import { useCallback, useId, useRef, useState } from "react";

/**
 * Every type the app can read, for a box that takes anything.
 *
 * The file picker's filter is a convenience, not a gate: routing is decided by
 * reading the file (lib/detect.ts), so a box that narrows this list can only
 * grey out a file the app would have handled perfectly well.
 */
export const ANY_FILE =
  ".ics,.csv,.tsv,.xlsx,.xls,.xlsm,.pdf,.png,.jpg,.jpeg,.webp,.heic,.txt," +
  "text/calendar,text/csv,text/plain,application/pdf,image/png,image/jpeg,image/webp";

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
