# ORDER

A week-planning instrument for a VMI cadet.

> **Ink is obligation. White space is freedom.**

Most planners assume you own your time. A cadet does not. The Matrix imposes
formations, parades, inspections, duty and CQ; the semester imposes classes;
Canvas imposes deadlines. The genuinely scarce resource is the gaps between
those — so this tool has one job:

**Tell me which hours are actually mine, and what to do in them.**

Drop your files in once a week — a spreadsheet or a CSV, whichever the Corps published. Get back a printable operations document: the
week as a grid, a tear-off page per day, and a written read on where the week
bites.

---

## Run it

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # 165 tests, all pure
```

Nothing else to provision. No database, no account, no API key. `GEMINI_API_KEY`
in `.env.local` turns on three advisory features; without it every other part
of the app — parsing, scheduling, printing — works unchanged.

---

## What it does that a calendar does not

**It tells you the truth about capacity.** If you have 14.5 hours of work and
9 hours of free time, it says exactly that, names the three blocks that did
not fit, and gives the one constraint that blocked each. A planner that
quietly crushes 14 hours into 9 and draws a tidy grid is lying to you, and
you find out on Thursday.

**It separates orders from suggestions.** What the Institute decided renders
solid. What the app decided renders with a dashed leading edge. At a glance,
on screen and on a photocopied page, you can always tell which is which.

**It explains itself.** Every generated block carries a trace: why this
window, what it was chosen over, which constraint bound it. Every piece that
did not fit names the binding constraint — *"the longest free window before
the deadline is 45m and this piece needs 90m"* — rather than shrugging.

**It reports institutional conflicts instead of hiding them.** When an
enrolled lab collides with mandatory training, both appear, and the app
declines to choose. That is a fact about your week that needs a human.

**It prints.** Three pages: the week as a grid, a day-by-day agenda with tick
boxes, and the deadline table with conflicts and shortfalls. Barracks device
restrictions are real, and a plan you cannot open is not a plan.

---

## Architecture

One Next.js app. No database, no accounts, no second service.

Parsing a CSV, differencing intervals and placing work into gaps are **pure
functions**, and the output is a sheet of paper. None of that needs a server,
so there isn't one. The consequences are worth stating plainly:

- **Your schedule never leaves the device.** A cadetship matrix carries
  unit-level movement detail. The strongest privacy guarantee available is for
  the file never to be uploaded anywhere, and that is what this gets for free
  — a better answer than a private bucket and signed URLs.
- **It works offline.** Which matters, given that the printed artifact exists
  because of the same constraints.
- **There is nothing to deploy but a static app.** One route runs on a server:
  the Canvas ICS proxy, because browsers cannot fetch the feed directly.
- **Clearing site data clears your plan.** Hence the export button, and the UI
  says so rather than pretending otherwise.

```
lib/domain/    time algebra, kind taxonomy, types
lib/parse/     csv · matrix (grid + tidy) · ics · course schedule
lib/engine/    the solver — pure, deterministic, golden-file tested
lib/ai/        advisory schema — constrains the solver, never schedules
lib/store/     client state, persistence, source → week derivation
components/    week grid, panels, uploads
app/           routes; api/canvas is the only stateful surface
```

### Time is an integer

Everything inside the engine is minutes from the start of the week, in local
wall clock. `0` is Monday 00:00.

The Institute schedules in wall clock: a 0700 formation is at 0700 on the
Sunday the clocks change, and on every other day of the year. Model the week
as absolute instants and you must re-derive that invariant on every read,
and a 23-hour day silently shifts every block after 02:00. Model it as
wall-clock minutes and the invariant is structural — DST cannot move a
formation, because a formation is not stored as an instant.

Absolute time exists at exactly one boundary, where Canvas hands us UTC, and
is converted once at ingest via the IANA database.

### The engine

```
generate_plan(events, tasks, preferences) -> Plan

  1  hard layer      matrix ∪ courses ∪ protected ∪ locked
                     pairwise overlaps → reported, never resolved
  2  free windows    week − hard − sleep − meals
  3  buffers         shrink each window edge that abuts an obligation
  4  filter          drop windows below the minimum block
  5  demand          tasks → chunks; order by least slack
  6  place           best-fit, deadline- and capacity-constrained
  7  assemble        capacity, narrative, fingerprint
```

Deterministic: same inputs and same `ENGINE_VERSION` produce a byte-identical
plan, enforced by `inputsFingerprint` and asserted by the tests. That is the
property that makes a wrong plan debuggable instead of a ghost story.

### Where the AI goes, and where it does not

Three advisory jobs: effort estimation, task decomposition, and turning *"I'm
behind on the Gilgamesh response and Thursday got eaten by guard duty"* into a
**constraint patch**. Then the deterministic solver re-runs.

**The model never emits a datetime that reaches the plan.** A blocked-out
window is a day index and two clock times, bounded and integer-valued — there
is no date for it to get wrong and nothing to parse. Three reasons, in order
of how much they hurt:

1. Non-determinism kills debugging. A plan you cannot reproduce is a plan you
   cannot fix.
2. Models are bad at interval arithmetic. They will double-book a Tuesday and
   be confident about it.
3. A solver run is under a millisecond. A model-authored week is fifteen
   seconds and a variable number of cents, every regeneration.

The AI makes the plan smarter. The solver makes it correct. Don't trade the
second for the first.

---

## Design

Atelier Warmth — warm ivory canvas, milled-stone surfaces, espresso ink,
`Newsreader` over `Plus Jakarta Sans`, tabular figures on every time label —
re-tuned in three ways for the fact that the deliverable is paper:

- The five accents are spaced in **lightness** as well as hue. On the original
  set, terracotta and sun ochre sit within a few points of each other, so on a
  mono printer a mandatory formation and an assignment deadline become the same
  grey.
- Every block carries a **glyph** and a **fill texture** as well as a hue. A
  kind is never encoded in colour alone.
- A **dark theme**, because reading a planner in a dark barracks room after
  taps is a real use case. The accents are re-tuned, not merely inverted.

The week grid: uniform time axis, seven columns, real overlap lanes, labels
that degrade by tier (full text → title → glyph) rather than truncating, and a
drawn hour range fitted to the content instead of hardcoded.

---

## Testing

```bash
npm test
```

165 tests, no server and no fixtures beyond three files:

- **Interval algebra** — including that subtract-then-union conserves minutes.
- **DST** — the week of 1 Nov 2026, where a naive implementation produces a
  23-hour day and misplaces everything after 02:00.
- **CSV hostility** — BOM, semicolon and tab delimiters, a decorative title
  row, quoted fields containing delimiters, an unbalanced quote, ragged rows,
  and a title merged across every column (which looks like a header until you
  notice every cell is the same value).
- **Spreadsheets** — read from a fixture written by a real Excel writer, not by
  this reader's own idea of the format: merged cells expanded, times stored as
  day fractions converted back to clock times, rich text rejoined, and empty
  self-closing cells that must not swallow the cells after them.
- **Matrix, both shapes** — grid melt, en-dash time ranges, midnight-crossing
  duty, uniform and applicability parsing, and that a cell reading `N/A` does
  not become an event.
- **ICS** — a due date is a zero-length marker; cancelled events skipped;
  folded lines; `TZID`, UTC, floating and date-only times; `RRULE` expanded
  only inside the week; upsert on UID.
- **The engine** — determinism, order-independence, no double-booking, lead
  times, daily ceilings, lock-and-regenerate, and that 30 hours of work into a
  10-hour week reports a shortfall rather than absorbing it.
- **Layout** — overlap lanes, and that neither an all-day marker nor a
  one-hour overnight tail can drag the drawn axis to midnight.
- **The printed sheet** — that a start off the 30-minute row grid carries its
  exact time (a 07:40 formation must never print as 07:30), and that an
  overnight duty is reported on the day it ends rather than vanishing.
- **Security** — the ICS proxy refuses plain http, IP literals, the metadata
  service, embedded credentials, non-standard ports, arbitrary hosts, and
  `instructure.com.evil.test`.

---

## Deliberately not built

No accounts, no multi-user, no admin term catalog, no billing, no template
marketplace, no drag-and-drop, no notifications, no calendar write-back.

Multi-user roughly doubles the work and is what would keep this from shipping.
Drag-and-drop is two weeks of work that **lock a block + regenerate** replaces
in an afternoon: a locked block is promoted into the hard layer on the next
run and everything else is rebuilt around it.

## Known limits

- **The matrix parser has never seen a real matrix.** It is built against the
  failure modes in `test/fixtures/` and the shapes described in the spec.
  Expect to fix it on first contact with the real file — which is why raw
  uploads are kept verbatim and re-parsed on every render.
- **`.xls` (the legacy binary format) is not read**, only `.xlsx`/`.xlsm`. The
  old format is not a ZIP and would need a different reader entirely; re-save
  as .xlsx or CSV.
- **A conflict prints once.** The screen grid lanes colliding blocks
  side-by-side; on paper the second one is listed in the conflict table rather
  than drawn as an unreadable sliver.
- **Recurrence support is a subset** — weekly and daily with `BYDAY`,
  `INTERVAL`, `COUNT` and `UNTIL`. Anything else yields the first occurrence
  and says so.
