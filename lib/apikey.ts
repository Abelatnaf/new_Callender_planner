"use client";

/**
 * A Gemini key supplied by the person using the app.
 *
 * This is the fallback for a deployment whose owner cannot set a server
 * environment variable. The key lives in this browser only and is sent with
 * each request, where it is used once and discarded.
 *
 * It is stored under its own localStorage entry rather than inside the vault,
 * deliberately: the vault is exported to a file from the Semester page, and a
 * downloadable JSON that quietly contains an API key is a bad surprise. It can
 * be carried in an export, but only when the cadet ticks the box for it.
 *
 * Browser storage is per-origin, which is the thing worth knowing when a key
 * seems to vanish: a Vercel preview URL is a different origin from the
 * production one, so a key saved on one is simply not present on the other.
 * `keyOrigin()` exists so the app can say that out loud instead of leaving it
 * to be discovered.
 */
import { useCallback, useEffect, useState } from "react";

const KEY = "order.gemini.key";

/** Header the API routes read. Mirrors KEY_HEADER in lib/api.ts. */
export const KEY_HEADER = "x-gemini-key";

export function readKey(): string {
  if (typeof window === "undefined") return "";
  try {
    const stored = window.localStorage.getItem(KEY);
    if (stored) return stored;
  } catch {
    /* blocked storage; try the weaker one below */
  }
  try {
    return window.sessionStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * Store the key. Returns whether it will survive closing the tab.
 *
 * A browser that blocks localStorage still usually allows sessionStorage, so a
 * private window gets a key that lasts the session rather than no key at all -
 * and the caller is told, so it can say which of the two happened.
 */
export function writeKey(value: string): boolean {
  if (typeof window === "undefined") return false;
  const v = value.trim();
  let durable = false;
  try {
    if (v) window.localStorage.setItem(KEY, v);
    else window.localStorage.removeItem(KEY);
    durable = true;
  } catch {
    /* private window or blocked storage */
  }
  try {
    if (v && !durable) window.sessionStorage.setItem(KEY, v);
    else if (!v) window.sessionStorage.removeItem(KEY);
  } catch {
    /* nothing left to try; the key lives only in memory for this page */
  }
  return durable;
}

/**
 * The origin this key is remembered for.
 *
 * Browser storage does not follow you to another URL. When a deployment hands
 * out a fresh preview URL on every push, that is the whole explanation for a
 * key that "keeps getting forgotten".
 */
export function keyOrigin(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.location.host;
  } catch {
    return "";
  }
}

/**
 * Is this the right kind of credential at all?
 *
 * A Google account hands out several things that look like secrets, and only
 * one of them works here. An AI Studio API key starts `AIza`; an OAuth token
 * (`AQ.`, `ya29.`) or a signed JWT is a different animal entirely and the
 * Generative Language API will simply refuse it. Recognising the common
 * mistakes by name costs nothing and saves a round trip that comes back as a
 * bare "rejected".
 *
 * Anything unrecognised is only flagged, never blocked: Google may mint a new
 * format tomorrow, and a guess of mine should not be what locks someone out.
 */
export type KeyVerdict =
  | { ok: true; warning?: string }
  | { ok: false; reason: string };

export function checkKeyShape(raw: string): KeyVerdict {
  const key = raw.trim();
  if (!key) return { ok: false, reason: "Paste a key first." };

  if (/^AQ\./.test(key) || /^ya29\./.test(key)) {
    return {
      ok: false,
      reason:
        "That is a Google OAuth token, not a Gemini API key — they are different credentials " +
        "and this one cannot call the Gemini API. An API key starts with AIza and comes from " +
        "aistudio.google.com/apikey. Revoke this one: it is not what you want, and you have " +
        "had it on your clipboard.",
    };
  }
  if (/^ey[A-Za-z0-9_-]+\.ey/.test(key)) {
    return {
      ok: false,
      reason:
        "That is a signed token (a JWT), not a Gemini API key. Get one at " +
        "aistudio.google.com/apikey — it starts with AIza.",
    };
  }
  if (/\s/.test(key)) {
    return { ok: false, reason: "That has a space in it — it was probably copied with something else." };
  }
  if (/^AIza/.test(key)) {
    return key.length >= 35
      ? { ok: true }
      : { ok: false, reason: "That looks like the start of a key but it is too short — copy the whole thing." };
  }
  return {
    ok: true,
    warning:
      "This does not look like an AI Studio key, which normally starts with AIza. Saved anyway — " +
      "if requests come back rejected, that is why.",
  };
}

/** Headers for a fetch to any Gemini-backed route. */
export function keyHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const k = readKey();
  return k ? { ...extra, [KEY_HEADER]: k } : extra;
}

export function useApiKey() {
  const [key, setKeyState] = useState("");
  const [ready, setReady] = useState(false);
  const [durable, setDurable] = useState(true);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setKeyState(readKey());
    setOrigin(keyOrigin());
    setReady(true);
  }, []);

  const setKey = useCallback((value: string) => {
    setDurable(writeKey(value));
    setKeyState(value.trim());
  }, []);

  return { key, setKey, ready, durable, origin, hasKey: key.trim().length > 0 };
}

/** What /api/health reports about this deployment's own key. */
export type Health = {
  ok: boolean;
  serverKey: boolean;
  keyProblem: string | null;
  keyWarning: string | null;
  keyNeedsTrim: boolean;
  models: { parse: string[]; plan: string[] };
};

/**
 * Ask the server about itself, once per mount.
 *
 * Null means the question has not been answered yet - either still in flight or
 * unreachable. Callers must treat null as "do not know", never as "no key":
 * flashing a key prompt at someone whose deployment is perfectly configured is
 * exactly the thing this whole path exists to avoid.
 */
export function useHealth(): Health | null {
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setHealth(d as Health); })
      .catch(() => { /* leave it unknown */ });
    return () => { cancelled = true; };
  }, []);
  return health;
}

/** Whether the server carries its own key, so the browser need not. */
export function useServerKey() {
  const health = useHealth();
  return health === null ? null : Boolean(health.serverKey);
}
