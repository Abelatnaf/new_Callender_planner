"use client";

/**
 * Collects a Gemini key when the deployment has none of its own.
 *
 * Shown only when `/api/health` reports no server key, so a properly configured
 * deployment never sees it.
 *
 * The saved state says which host the key is remembered for. That is not
 * decoration: browser storage is per-origin, and a hosting platform that hands
 * out a fresh preview URL on every push is the whole explanation for a key that
 * "keeps getting forgotten". Naming the host turns a mystery into a fact.
 */
import { useState } from "react";
import { checkKeyShape, useApiKey, useServerKey } from "@/lib/apikey";

export function KeyGate({ compact = false }: { compact?: boolean }) {
  const serverKey = useServerKey();
  const { key, setKey, ready, hasKey, durable, origin } = useApiKey();
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState(false);
  const [why, setWhy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  // Catch the credential that is the wrong kind entirely before spending a
  // request on it. Google hands out several secrets; only one calls this API.
  const submit = (value: string) => {
    const verdict = checkKeyShape(value);
    if (!verdict.ok) {
      setProblem(verdict.reason);
      setWarning(null);
      return;
    }
    setProblem(null);
    setWarning(verdict.warning ?? null);
    setKey(value);
    setDraft("");
    setSaved(true);
  };

  // Server has its own key, or we could not reach health: say nothing.
  if (serverKey !== false || !ready) return null;

  if (hasKey) {
    if (compact) return null;
    return (
      <div className="notice" style={{ marginTop: "var(--s-6)" }}>
        <div className="notice__title">Using your own Gemini key</div>
        This deployment has no server key, so requests use the key stored in
        {origin ? <> <strong>{origin}</strong></> : " this browser"} (…{key.slice(-4)}).
        It is never written to your vault export unless you tick the box for it.{" "}
        <button
          className="btn btn--sm btn--ghost"
          style={{ marginLeft: 6 }}
          onClick={() => { setKey(""); setSaved(false); }}
        >
          Remove
        </button>
        <button
          className="btn btn--sm btn--ghost"
          style={{ marginLeft: 6 }}
          aria-expanded={why}
          onClick={() => setWhy((w) => !w)}
        >
          {why ? "Hide" : "Stop being asked for this"}
        </button>

        {!durable && (
          <div style={{ marginTop: "var(--s-2)" }}>
            This browser is blocking long-term storage, so the key will be forgotten
            when you close the tab.
          </div>
        )}

        {why && <Permanently origin={origin} />}
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
        onSubmit={(e) => { e.preventDefault(); submit(draft); }}
      >
        <input
          className="input"
          style={{ flex: 1, minWidth: 240 }}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="Paste your Gemini API key"
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setProblem(null); }}
          aria-label="Gemini API key"
          aria-invalid={problem !== null}
          aria-describedby={problem ? "key-problem" : undefined}
        />
        <button className="btn btn--solid" type="submit" disabled={!draft.trim()}>
          Save key
        </button>
        {saved && !problem && <span className="label label--ink">Saved</span>}
      </form>

      {problem && (
        <p id="key-problem" role="alert" style={{ marginTop: "var(--s-2)", fontWeight: 600 }}>
          {problem}
        </p>
      )}
      {warning && !problem && (
        <p style={{ marginTop: "var(--s-2)" }}>{warning}</p>
      )}
      <p style={{ marginTop: "var(--s-2)" }}>
        <button className="btn btn--sm btn--ghost" aria-expanded={why} onClick={() => setWhy((w) => !w)}>
          {why ? "Hide" : "Tired of pasting this?"}
        </button>
      </p>
      {why && <Permanently origin={origin} />}
    </div>
  );
}

/** The two ways to stop being asked, in the order of how well they work. */
function Permanently({ origin }: { origin: string }) {
  return (
    <div style={{ marginTop: "var(--s-4)" }}>
      <div className="label label--ink">Why this keeps coming back</div>
      <p style={{ marginTop: 4 }}>
        The key is remembered <strong>per web address</strong>, so it is stored for{" "}
        <strong>{origin || "this address"}</strong> and nowhere else. A hosting platform that
        gives each deployment its own preview URL is therefore handing you a fresh, empty
        browser every time. Two ways to end it:
      </p>
      <ol style={{ marginTop: "var(--s-2)", paddingLeft: "1.2em" }}>
        <li style={{ marginBottom: 4 }}>
          <strong>Set it on the server, once.</strong> In Vercel → your project → Settings →
          Environment Variables, add <code>GEMINI_API_KEY</code> with your key, then redeploy.
          This box disappears for good, on every device and every URL.
        </li>
        <li>
          <strong>Or carry it with your data.</strong> Below, tick{" "}
          <em>Include my Gemini key</em> before exporting your vault. Importing that file
          anywhere brings the key back with everything else.
        </li>
      </ol>
      <p style={{ marginTop: "var(--s-2)" }}>
        Either way, always open the site at the same address — bookmark it rather than
        following a fresh deployment link.
      </p>
    </div>
  );
}
