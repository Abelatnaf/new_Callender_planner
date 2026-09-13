'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { deriveWeek, type DerivedWeek } from '@/lib/store/derive'
import {
  defaultState,
  loadState,
  saveState,
  type AppState,
  type CanvasSource,
  type ManualEvent,
  type RawSource,
} from '@/lib/store/state'
import { addDays, weekStartOf, type LocalDate } from '@/lib/domain/time'
import type { Preferences, Profile, Task } from '@/lib/domain/types'
import type { ConstraintPatch } from '@/lib/engine/solve'

interface PlannerContextValue {
  state: AppState
  week: DerivedWeek
  /** True until the stored state has been read on the client. */
  hydrating: boolean
  /** Set when the browser refuses to persist. Shown, not swallowed. */
  storageWarning: string | null
  today: LocalDate
  patch: ConstraintPatch | null
  setPatch: (patch: ConstraintPatch | null) => void
  update: (mutate: (draft: AppState) => AppState) => void
  setProfile: (profile: Profile) => void
  setPreferences: (preferences: Preferences) => void
  setMatrix: (source: RawSource | null) => void
  setTerm: (source: RawSource | null) => void
  setCanvas: (source: CanvasSource | null) => void
  rememberMapping: (fingerprint: string, mapping: Record<string, string>) => void
  addManualEvent: (event: ManualEvent) => void
  removeManualEvent: (id: string) => void
  addManualTask: (task: Task) => void
  removeManualTask: (id: string) => void
  overrideTask: (key: string, patch: { estimateMinutes?: number; status?: Task['status']; weight?: number }) => void
  toggleLock: (signature: string) => void
  goToWeek: (weekStart: LocalDate) => void
  shiftWeek: (weeks: number) => void
  setTheme: (theme: AppState['theme']) => void
  reset: () => void
}

const PlannerContext = createContext<PlannerContextValue | null>(null)

/** Today as a local ISO date, computed once per mount. */
function todayLocal(): LocalDate {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function PlannerProvider({ children }: { children: ReactNode }): ReactNode {
  // `today` must be identical on server and client for the first paint, so it
  // is seeded deterministically and corrected after mount.
  const [today, setToday] = useState<LocalDate>('1970-01-01')
  const [state, setState] = useState<AppState>(() => defaultState('1970-01-01'))
  const [hydrating, setHydrating] = useState(true)
  const [storageWarning, setStorageWarning] = useState<string | null>(null)
  const [patch, setPatch] = useState<ConstraintPatch | null>(null)
  const firstRun = useRef(true)

  useEffect(() => {
    const now = todayLocal()
    setToday(now)
    setState(loadState(now))
    setHydrating(false)
  }, [])

  useEffect(() => {
    if (hydrating || firstRun.current) {
      firstRun.current = false
      return
    }
    const result = saveState(state)
    setStorageWarning(result.ok ? null : (result.error ?? null))
  }, [state, hydrating])

  // Reflect the theme choice onto the document so CSS can resolve it.
  useEffect(() => {
    const root = document.documentElement
    if (state.theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', state.theme)
  }, [state.theme])

  const update = useCallback((mutate: (draft: AppState) => AppState) => {
    setState((current) => mutate(current))
  }, [])

  const week = useMemo(
    () => deriveWeek(state, state.selectedWeek, patch ?? undefined),
    [state, patch],
  )

  const value = useMemo<PlannerContextValue>(
    () => ({
      state,
      week,
      hydrating,
      storageWarning,
      today,
      patch,
      setPatch,
      update,
      setProfile: (profile) => update((s) => ({ ...s, profile })),
      setPreferences: (preferences) => update((s) => ({ ...s, preferences })),
      setMatrix: (matrix) => update((s) => ({ ...s, matrix })),
      setTerm: (term) => update((s) => ({ ...s, term })),
      setCanvas: (canvas) => update((s) => ({ ...s, canvas })),
      rememberMapping: (fingerprint, mapping) =>
        update((s) =>
          s.matrix
            ? {
                ...s,
                matrix: {
                  ...s.matrix,
                  mappings: { ...(s.matrix.mappings ?? {}), [fingerprint]: mapping },
                },
              }
            : s,
        ),
      addManualEvent: (event) => update((s) => ({ ...s, manualEvents: [...s.manualEvents, event] })),
      removeManualEvent: (id) =>
        update((s) => ({ ...s, manualEvents: s.manualEvents.filter((e) => e.id !== id) })),
      addManualTask: (task) => update((s) => ({ ...s, manualTasks: [...s.manualTasks, task] })),
      removeManualTask: (id) =>
        update((s) => ({ ...s, manualTasks: s.manualTasks.filter((t) => t.id !== id) })),
      overrideTask: (key, taskPatch) =>
        update((s) => ({
          ...s,
          taskOverrides: {
            ...s.taskOverrides,
            [key]: { ...(s.taskOverrides[key] ?? {}), ...taskPatch },
          },
        })),
      toggleLock: (signature) =>
        update((s) => {
          const current = s.locks[s.selectedWeek] ?? []
          const next = current.includes(signature)
            ? current.filter((x) => x !== signature)
            : [...current, signature]
          return { ...s, locks: { ...s.locks, [s.selectedWeek]: next } }
        }),
      goToWeek: (weekStart) => update((s) => ({ ...s, selectedWeek: weekStartOf(weekStart) })),
      shiftWeek: (weeks) =>
        update((s) => ({ ...s, selectedWeek: addDays(s.selectedWeek, weeks * 7) })),
      setTheme: (theme) => update((s) => ({ ...s, theme })),
      reset: () => setState(defaultState(today)),
    }),
    [state, week, hydrating, storageWarning, today, patch, update],
  )

  return <PlannerContext.Provider value={value}>{children}</PlannerContext.Provider>
}

export function usePlanner(): PlannerContextValue {
  const context = useContext(PlannerContext)
  if (!context) throw new Error('usePlanner must be used inside a PlannerProvider')
  return context
}
