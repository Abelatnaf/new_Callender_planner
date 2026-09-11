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

const KEY = "order.vault.v1";

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
  exportVault: () => void;
  importVault: (file: File) => Promise<{ ok: boolean; error?: string }>;
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

  const exportVault = useCallback(() => {
    const blob = new Blob([JSON.stringify(vault, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `order-vault-${todayLocal(vault.settings.timezone)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [vault]);

  const importVault = useCallback(async (file: File) => {
    try {
      const parsed = VaultSchema.safeParse(JSON.parse(await file.text()));
      if (!parsed.success) {
        return { ok: false, error: "That file is not an ORDER vault export." };
      }
      update(() => parsed.data);
      return { ok: true };
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
