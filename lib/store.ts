"use client";

/**
 * Local persistence.
 *
 * Everything lives in this browser. No accounts, no login, no server-side copy
 * of a cadet's schedule. The escape hatch is a single JSON vault file that can
 * be exported and re-imported, so the data moves between a laptop and a phone
 * without anyone needing to run a database - and is never locked in here.
 *
 * Raw uploads are deliberately not kept. The parsed result is stored and fully
 * editable, so holding onto the original spreadsheet buys nothing but bulk.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type Assignment, type MatrixWeek, type Plan, type Settings, type Term,
  type Vault, VaultSchema,
} from "./schemas";
import { weekStart, todayLocal } from "./time";
import { readKey, writeKey } from "./apikey";

const KEY = "order.vault.v1";

/**
 * The JSON an export writes.
 *
 * The key rides alongside the vault rather than inside it, so VaultSchema stays
 * the single description of what vault state is and a carried key can never
 * leak into it.
 */
export function vaultExportPayload(vault: Vault, key: string): Record<string, unknown> {
  return key.trim() ? { ...vault, geminiKey: key.trim() } : { ...vault };
}

/** The key an import file carries, if its author ticked the box. */
export function carriedKey(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const value = (raw as { geminiKey?: unknown }).geminiKey;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function emptyVault(): Vault {
  return VaultSchema.parse({ version: 1, settings: {} });
}

/** Storage can throw: private windows, blocked site data, quota. Never crash. */
export function loadVault(): Vault {
  if (typeof window === "undefined") return emptyVault();
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return emptyVault();
    const parsed = VaultSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      console.warn("Stored vault did not validate; starting fresh.", parsed.error.issues);
      return emptyVault();
    }
    return parsed.data;
  } catch {
    return emptyVault();
  }
}

export function saveVault(vault: Vault): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(vault));
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------- hook */

export type VaultApi = {
  vault: Vault;
  ready: boolean;
  /** True when the last write to storage failed (quota, private window). */
  storageFailed: boolean;
  update: (fn: (v: Vault) => Vault) => void;
  setTerm: (term: Term) => void;
  setSettings: (patch: Partial<Settings>) => void;
  setAssignments: (a: Assignment[]) => void;
  upsertMatrixWeek: (w: MatrixWeek) => void;
  upsertPlan: (p: Plan) => void;
  reset: () => void;
  exportVault: (opts?: { includeKey?: boolean }) => void;
  importVault: (file: File) => Promise<{ ok: boolean; error?: string; keyRestored?: boolean }>;
};

export function useVault(): VaultApi {
  const [vault, setVault] = useState<Vault>(emptyVault);
  const [ready, setReady] = useState(false);
  const [storageFailed, setStorageFailed] = useState(false);

  useEffect(() => {
    setVault(loadVault());
    setReady(true);
  }, []);

  const update = useCallback((fn: (v: Vault) => Vault) => {
    setVault((prev) => {
      const next = fn(prev);
      setStorageFailed(!saveVault(next));
      return next;
    });
  }, []);

  const setTerm = useCallback((term: Term) => {
    update((v) => ({
      ...v,
      term,
      // Keep the outgoing term so a mid-semester mistake is recoverable.
      termHistory: v.term && v.term.id !== term.id ? [v.term, ...v.termHistory].slice(0, 6) : v.termHistory,
    }));
  }, [update]);

  const setSettings = useCallback((patch: Partial<Settings>) => {
    update((v) => ({ ...v, settings: { ...v.settings, ...patch } }));
  }, [update]);

  const setAssignments = useCallback((assignments: Assignment[]) => {
    update((v) => ({ ...v, assignments }));
  }, [update]);

  const upsertMatrixWeek = useCallback((week: MatrixWeek) => {
    update((v) => ({
      ...v,
      matrixWeeks: [week, ...v.matrixWeeks.filter((w) => w.weekStart !== week.weekStart)]
        .sort((a, b) => b.weekStart.localeCompare(a.weekStart))
        .slice(0, 20),
    }));
  }, [update]);

  const upsertPlan = useCallback((plan: Plan) => {
    update((v) => ({
      ...v,
      plans: [plan, ...v.plans.filter((p) => p.weekStart !== plan.weekStart)]
        .sort((a, b) => b.weekStart.localeCompare(a.weekStart))
        .slice(0, 20),
    }));
  }, [update]);

  const reset = useCallback(() => update(() => emptyVault()), [update]);

  /**
   * The whole vault as one file.
   *
   * The Gemini key is left out by default - a downloadable JSON that quietly
   * contains an API key is a bad surprise. Including it is a deliberate tick,
   * and it is what makes moving to a new browser, device or deployment URL a
   * single import rather than a hunt for the key all over again.
   */
  const exportVault = useCallback((opts?: { includeKey?: boolean }) => {
    const payload = vaultExportPayload(vault, opts?.includeKey ? readKey() : "");
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `order-vault-${todayLocal(vault.settings.timezone)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [vault]);

  const importVault = useCallback(async (file: File) => {
    try {
      const raw: unknown = JSON.parse(await file.text());
      const parsed = VaultSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: "That file is not an ORDER vault export." };
      }
      update(() => parsed.data);

      // Carried only if the export was ticked to include it. VaultSchema strips
      // the field, so it is read off the raw JSON before parsing throws it away.
      const carried = carriedKey(raw);
      if (carried) writeKey(carried);

      return { ok: true, keyRestored: carried !== null };
    } catch {
      return { ok: false, error: "That file could not be read as JSON." };
    }
  }, [update]);

  return useMemo(
    () => ({
      vault, ready, storageFailed, update, setTerm, setSettings,
      setAssignments, upsertMatrixWeek, upsertPlan, reset, exportVault, importVault,
    }),
    [vault, ready, storageFailed, update, setTerm, setSettings, setAssignments,
     upsertMatrixWeek, upsertPlan, reset, exportVault, importVault],
  );
}

/* --------------------------------------------------------------- selectors */

export function currentWeekStart(vault: Vault): string {
  return weekStart(todayLocal(vault.settings.timezone));
}

export function weekFor(vault: Vault, weekStartDate: string): MatrixWeek | null {
  return vault.matrixWeeks.find((w) => w.weekStart === weekStartDate) ?? null;
}

export function planFor(vault: Vault, weekStartDate: string): Plan | null {
  return vault.plans.find((p) => p.weekStart === weekStartDate) ?? null;
}
