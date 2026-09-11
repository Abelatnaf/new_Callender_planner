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

/** Whether the server carries its own key, so the browser need not. */
export function useServerKey() {
  const [serverKey, setServerKey] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setServerKey(Boolean(d?.serverKey)); })
      .catch(() => { if (!cancelled) setServerKey(null); });
    return () => { cancelled = true; };
  }, []);
  return serverKey;
}
