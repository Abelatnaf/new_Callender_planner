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
 * downloadable JSON that quietly contains an API key is a bad surprise.
 */
import { useCallback, useEffect, useState } from "react";

const KEY = "order.gemini.key";

/** Header the API routes read. Mirrors KEY_HEADER in lib/api.ts. */
export const KEY_HEADER = "x-gemini-key";

export function readKey(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

function writeKey(value: string): void {
  if (typeof window === "undefined") return;
  try {
    if (value.trim()) window.localStorage.setItem(KEY, value.trim());
    else window.localStorage.removeItem(KEY);
  } catch {
    /* private window or blocked storage; the key simply will not persist */
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

  useEffect(() => {
    setKeyState(readKey());
    setReady(true);
  }, []);

  const setKey = useCallback((value: string) => {
    writeKey(value);
    setKeyState(value.trim());
  }, []);

  return { key, setKey, ready, hasKey: key.trim().length > 0 };
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
