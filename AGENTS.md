<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# ORDER — working notes

## The one rule that is not negotiable

**The LLM never emits a datetime that reaches the plan.** Estimates, labels,
decompositions, constraint patches, prose — yes. Calendar arithmetic — no.

A constraint patch expresses blocked-out time as a day index (0–6) plus two
clock times in minutes past midnight. There is no date for a model to get
wrong and nothing to parse. `lib/ai/schema.ts` enforces this with zod and
`test/api.test.ts` asserts that an ISO datetime is rejected.

## Architecture, in one paragraph

One Next.js app, no database, no accounts, no Python service. Parsing a
schedule, differencing intervals and placing work are pure functions, and the
deliverable is a printed page, so none of it needs a server. State lives in
`localStorage`; raw uploads are kept verbatim so a parser fix can be replayed.
The only server-side code is the Canvas ICS proxy (browsers cannot fetch the
feed — no CORS headers) and the optional advisory AI endpoint.

## Time

Everything inside the engine is an integer: minutes from the start of the
planning week, in **local wall clock**. `0` is Monday 00:00, `10080` is the
following Monday.

Do not reach for `Date` inside the engine. The Institute schedules in wall
clock — a 0700 formation is at 0700 on the Sunday the clocks change — and
modelling the week as wall-clock minutes makes that invariant structural
rather than something to re-derive. Absolute time exists at exactly one
boundary, `instantToWeekMinutes`, where Canvas hands us UTC.

## Layout of the code

    lib/domain/    time algebra, the kind taxonomy, types
    lib/parse/     csv, matrix (both shapes), ics, term schedule
    lib/engine/    the solver. pure, deterministic, tested
    lib/ai/        the advisory schema. constrains, never schedules
    lib/store/     client state, persistence, source → week derivation
    components/    grid, panels, uploads
    app/           routes; api/canvas is the only stateful surface

## Invariants worth breaking a build over

- Same inputs and same `ENGINE_VERSION` produce a byte-identical plan.
  Asserted in `test/engine.test.ts`; `inputsFingerprint` is the mechanism.
- Generated study blocks never overlap each other or a hard event.
- A Canvas due date is a **zero-length marker**, never an occupied block.
  Reading a deadline as a one-hour meeting invents time the cadet does not owe
  and corrupts every free-window calculation downstream.
- Hard blocks render solid; generated blocks render with a dashed leading
  edge. On screen and on paper. One CSS class, and the most important visual
  decision in the app.
- Over-capacity is reported, never absorbed. If the work does not fit, the
  plan says so and names the binding constraint.
- Conflicts are reported, never resolved. The app does not pick which
  obligation you skip.

## Running it

    npm run dev        # turbopack is the default in Next 16
    npm test           # vitest, ~165 tests, all pure — no server needed
    npm run typecheck
    npm run build
