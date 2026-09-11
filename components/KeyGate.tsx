"use client";

/**
 * Collects a Gemini key when the deployment has none of its own.
 *
 * Shown only when `/api/health` reports no server key, so a properly configured
 * deployment never sees it.
 */
import { useState } from "react";
import { useApiKey, useServerKey } from "@/lib/apikey";

export function KeyGate({ compact = false }: { compact?: boolean }) {
  const serverKey = useServerKey();
  const { key, setKey, ready, hasKey } = useApiKey();
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState(false);

  // Server has its own key, or we could not reach health: say nothing.
  if (serverKey !== false || !ready) return null;

  if (hasKey) {
    if (compact) return null;
    return (
      <div className="notice" style={{ marginTop: "var(--s-6)" }}>
        <div className="notice__title">Using your own Gemini key</div>
        This deployment has no server key, so requests use the key stored in this browser
        (…{key.slice(-4)}). It is never written to your vault export.{" "}
        <button
          className="btn btn--sm btn--ghost"
          style={{ marginLeft: 6 }}
          onClick={() => { setKey(""); setSaved(false); }}
        >
          Remove
        </button>
      </div>
    );
  }

  return (
    <div className="notice" style={{ marginTop: "var(--s-6)", borderLeft: "3px solid var(--blue)" }}>
      <div className="notice__title">Add your Gemini key to finish setup</div>
      <p style={{ marginBottom: "var(--s-2)" }}>
        This deployment has no server key set. Paste your own and everything works — it stays
        in this browser, is sent only to this site&apos;s own API, and is kept out of your
        vault export. Get one free at{" "}
        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
          aistudio.google.com/apikey
        </a>.
      </p>
      <form
        style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap", alignItems: "center" }}
        onSubmit={(e) => { e.preventDefault(); setKey(draft); setDraft(""); setSaved(true); }}
      >
        <input
          className="input"
          style={{ flex: 1, minWidth: 240 }}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="Paste your Gemini API key"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="Gemini API key"
        />
        <button className="btn btn--solid" type="submit" disabled={!draft.trim()}>
          Save key
        </button>
        {saved && <span className="label label--ink">Saved</span>}
      </form>
    </div>
  );
}
