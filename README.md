# ORDER

A week-planning instrument for a VMI cadet.

> **Ink is obligation. White space is freedom.**

Most planners assume you own your time. A cadet does not. The Matrix imposes
formations, parades, inspections, duty and CQ; the semester imposes classes;
Canvas imposes deadlines. The genuinely scarce resource is the gaps between
those — so this tool has one job:

**Tell me which hours are actually mine, and what to do in them.**

Drop two files in once a week. Get back a printable operations document: the
week as a time-ribbon, a ranked backlog, and a tear-off page per day, with work
already placed into real free gaps and a written read on where the week bites.

---

## The weekly ritual

0. **`/setup`** — set your class, company and athletics once. The Matrix lists
   the whole Corps' week; this is how the app knows which rows are yours.
1. **`/setup`** — once a term, load your semester schedule. A screenshot of VMI
   Student Planning works, as do PDF, Excel, CSV or pasted text. Edit anything
   the import got wrong.
2. **`/intake`** — once a week, drop in the Matrix (CSV, Excel or PDF) and your
   Canvas calendar export (`.ics`). Confirm anything Gemini was unsure about.
3. **`/`** — press *Plan this week*.
4. **`/document`** — print it.

Then, during the week: click any work block to tick it off, nudge it earlier or
later, lengthen it, lock it so a re-plan leaves it alone, or remove it. Every
edit goes through the same safety check the planner does, so a block you move by
hand can no more land on a formation than one the model placed.

---

## How it decides things

The division of labour is the whole reliability story:

| | does what |
|---|---|
| **Code** | computes the free-gap inventory, exactly, from real intervals |
| **Gemini** | decides what to work on, how long it takes, and which gap it belongs in |
| **Code** | re-derives every placement and refuses the ones that do not fit |

Gemini never sees a blank calendar and is never asked to do clock arithmetic.
It is handed a numbered list of real free slots and may only place work by slot
id. Everything it returns is a proposal, not an answer.

### PAX: most of the Matrix is not yours

The Matrix is the whole Corps' week. Band Practice is for Band, Guard Mount
rotates by company, Rat Challenge is for Rats, and a Blood Drive is opt-in. Every
row carries a **PAX** column saying who it is for, and treating all of them as
obligations would erase your week under other people's duties.

So the app knows who you are — class, company, athletics — and each row is
scoped against that. A row that is not yours stays visible for reference but
never consumes time.

### The availability ratchet

A planner that is wrong about an *obligation* is worse than no planner, because
the printed page carries authority. Mislabel a formation as free time and the
cadet is in the library when they should be in ranks.

So the ratchet only turns one way. Gemini classifies each Matrix block as
`BLOCKED`, `USABLE` or `PARTIAL` — and below a confidence floor, any
non-blocking classification is forced to `BLOCKED` and flagged for review
(`lib/convert.ts`). The prompt asks for this too, but the prompt is a request
and the code is a guarantee.

The asymmetry is deliberate: forcing `BLOCKED` costs study time the cadet might
have had. Trusting a wrong `USABLE` costs a formation. We pay the cheap error
every time, and every AI-classified block is visibly ticked on screen and in
print so a wrong call is legible before it costs anything.

`USABLE` and `PARTIAL` events never subtract time — they only *describe* time
that is already free. A misclassification can restrict the day but can never
silently open it.

The same asymmetry governs PAX: when the model is unsure whether a row is yours,
it is treated as yours and blocked. Wrongly told you are busy costs an hour;
wrongly told you are free costs a formation.

### The Matrix export is 74% garbage

The real file is 2.4 MB — 146 rows by 16,380 columns — but only 8,336 cells hold
anything, and 6,132 of those are one row fill-righted across a thousand columns
by a spreadsheet drag. `trimSheet` in `lib/xlsx.ts` removes them by **column
occupancy**: a real column (a day, a sport, a field) is used by many rows, while
each artifact column is touched by exactly one. That takes the file to 2,204
cells in 19 columns with every day section intact.

---

## Running it

```bash
npm install
cp .env.example .env.local     # then add your Gemini API key
npm run dev
```

Get a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
`GET /api/health` reports whether the key is configured.

### Two ways to supply the key

**Server key (preferred).** Set `GEMINI_API_KEY` in the environment. It is read
server-side only, never reaches the browser, and every visitor is covered.

**Your own key (fallback).** If no server key is set, the app says so and offers
a field to paste one. That key is kept in your browser's `localStorage`, sent
with each request as a header, used once and discarded server-side. It is never
logged, and it is deliberately stored outside the vault so a vault export never
contains it.

The fallback exists because the person running the app is not always the person
who can edit its environment variables. A server key always wins when present.

```bash
npm test          # 141 unit + integration tests
npm run typecheck
npm run build
```

### Deploying to Vercel

Import the repo, then set **`GEMINI_API_KEY`** in Project → Settings →
Environment Variables. Nothing else is required. The key is read server-side
only and never reaches the browser.

`vercel.json` pins the framework to `nextjs`, so a project whose dashboard
preset is wrong (or was set before this repo had any code in it) still builds
correctly.

Model ids default to the floating aliases `gemini-pro-latest` and
`gemini-flash-latest` so a model retirement cannot break the tool. Pin them with
`GEMINI_MODEL_PLAN` / `GEMINI_MODEL_PARSE` if you want a fixed version.

### When the deployment misbehaves

`GET /api/health` is the single check for all of this.

**Every route returns a plain `404: NOT_FOUND`.** That is Vercel's own error
page, not this app's — the app's 404 is ink on newsprint and says *No such
page*. A plain one means nothing is being served, which almost always means the
project's **Framework Preset is "Other"**: connect an empty repo to Vercel and
it detects no framework, runs no build, and serves the bare repository root.
The preset is sticky, so adding Next.js later does not revisit it.

> Project → Settings → Build & Deployment → Framework Preset → **Next.js** →
> Save, then Deployments → latest → ⋯ → **Redeploy**.

**The site loads, but Matrix import, planning and Ask all fail with 503.**
No Gemini key is available. Either set `GEMINI_API_KEY` and redeploy, or paste
your own key into the prompt the app shows you — that works immediately and
needs no access to the hosting environment. Canvas `.ics` import keeps working
throughout either way, because that parser is deterministic and never calls
Gemini.

**Key added, still 503.** Environment variables do not apply to builds that
already ran. Redeploy.

**401, "that Gemini API key was rejected".** The key is wrong or incomplete, or
the Generative Language API is not enabled for it.

---

## Your data

Everything lives in your browser's `localStorage`. There are no accounts, no
login, and no server-side copy of your schedule. Uploaded files are parsed and
discarded — only the structured result is kept, and all of it is editable.

`/setup` → *Export everything* writes a single JSON vault you can re-import on
another device. That is the whole sync story, and it means you are never locked
in here.

---

## Layout

```
app/
  page.tsx          The Week — the flagship screen
  intake/           Weekly drop zone + classification review
  setup/            Semester manager + settings
  backlog/          Everything with a deadline
  document/         The printable deliverable, 9 sheets
  api/parse/matrix  Matrix .xlsx  -> classified events
  api/parse/term    Semester file -> courses
  api/plan          gaps + backlog -> validated plan
  api/ask           streaming Q&A grounded in the real week
lib/
  time.ts           wall-clock minutes model, DST-safe tz crossing
  intervals.ts      half-open interval algebra
  gaps.ts           the free-gap inventory          <- pure, tested
  validate.ts       plan validator and repair       <- pure, tested
  ics.ts            deterministic Canvas parser (no model involved)
  xlsx.ts           Matrix grid extraction, merge spans preserved
  convert.ts        model output -> internal types, ratchet enforced
  schemas.ts        zod schemas; also emit Gemini's responseSchema
components/Ribbon.tsx   the signature component
styles/                 tokens, globals, ribbon, print
```

### Design — your week is made of light

Every calendar draws the *events*. This one draws the **gaps**, because the
question the app exists to answer is *"which hours are actually mine?"* — and
drawing that answer as empty space was backwards.

So the free time glows, and the obligations are the void it is carved out of.
More light means more time. There is no interpretation step between looking and
knowing.

| | |
|---|---|
| **glowing band** | free — *yours* |
| **dimmed, frosted** | yours, but confined to quarters (CQ) |
| **dark void** | taken from you — formation, class, duty |
| **solid chip in the light** | work you claimed, coloured by course |

**The light carries a second signal.** Its hue sweeps with the hour — gold
through the morning, cyan at midday, violet in the evening, indigo at night — so
the *colour* of a window tells you *when* it falls. A gold week has mornings; a
violet week does not. A long Sunday reads as a full sunrise-to-night sweep,
which is both better looking and strictly more informative than a flat bar.

Dark-first, because glow does not exist on white. Light mode is a genuine
inversion rather than a dimmed copy: free time becomes saturated colour on
white, obligations become solid graphite. Same sentence, told in ink.

Real SF Pro renders on Apple hardware — the font stack puts the system face
first, so nothing downloads there; Inter is vendored under `public/fonts`
(SIL OFL 1.1) as the substitute everywhere else.

**Print inverts one more time, and gains from it.** On paper the free time is
simply white and the obligations are the filled shapes — which is what a printed
schedule wants, and costs a fraction of the toner a glowing week would.

---

## Known limits

- Canvas `.ics` must be re-exported and dropped in each week; there is no live
  feed (Canvas blocks direct browser fetches, and the manual path was the
  chosen trade).
- Work blocks are adjusted by nudging (±15 min) rather than dragging. Drag is
  worse on every axis that matters here: unusable by keyboard, awkward on a
  phone, and it invites a drop that then has to be silently rejected.
- A block spanning the 0200 DST transition would be mis-measured. Nothing is
  scheduled at 0200, so this has not been handled.
