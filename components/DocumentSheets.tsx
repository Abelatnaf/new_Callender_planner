"use client";

/**
 * The printed week.
 *
 * Built to the shape of the reference document a cadet actually asked for: a
 * page per day carrying an oxblood masthead, two timeline columns and a rail,
 * then a courses page and a study plan that shows its working.
 *
 * Every figure here comes from lib/document.ts. Nothing is computed in this
 * file, because a number computed inside JSX is a number nobody can test, and
 * this is the one surface where a mistake reaches a formation.
 */
import type {
  CourseLine, DayPage as DayModel, DayRow, DocumentModel, StudyPlan,
} from "@/lib/document";
import { formatDuration, hhmm, shortDate } from "@/lib/time";

/** Course colour, shared with the screen so a course is one colour everywhere. */
function hue(hues: Map<string, number>, code?: string): string | undefined {
  if (!code) return undefined;
  const i = hues.get(code);
  return i === undefined ? undefined : `var(--c${i})`;
}
function tint(hues: Map<string, number>, code?: string): string | undefined {
  if (!code) return undefined;
  const i = hues.get(code);
  return i === undefined ? undefined : `var(--c${i}-tint)`;
}

/* ------------------------------------------------------------------- day */

export function DaySheet({ day, hues, index, total }: {
  day: DayModel; hues: Map<string, number>; index: number; total: number;
}) {
  return (
    <section className="page" aria-label={`${day.weekday} ${day.monthLabel}`}>
      <header className="crest">
        <div className="crest__left">
          <h2 className="crest__day">{day.weekday}</h2>
          <div className="crest__date">{day.monthLabel}</div>
          {day.tag && <div className="crest__tag">{day.tag}</div>}
        </div>

        <div className="crest__mid">
          {day.uniform && (
            <>
              <div className="crest__label">Uniform</div>
              <div className="crest__uniform">{day.uniform}</div>
            </>
          )}
          <div className="pills">
            {day.pills.map((p) => (
              <span className="pill" key={p.label}>{p.label} · {p.value}</span>
            ))}
          </div>
          <WeekDots current={index} />
        </div>

        <div className="crest__numeral" aria-hidden="true">{day.numeral}</div>
      </header>

      {day.cautions.map((c) => (
        <p className="caution" key={c}>{c}</p>
      ))}

      <div className="day-grid">
        <Column title="Morning" rows={day.morning} hues={hues} />
        <Column title="Afternoon + Evening" rows={day.evening} hues={hues} />

        <aside className="rail">
          <section className="rail__block">
            <h3 className="rail__title">Due today</h3>
            {day.due.length === 0 ? (
              <p className="rail__empty">Nothing due.</p>
            ) : (
              day.due.map((a) => (
                <div className="due" key={a.id}>
                  {a.courseCode && (
                    <span className="chip-code" style={{ color: hue(hues, a.courseCode), background: tint(hues, a.courseCode) }}>
                      {a.courseCode}
                    </span>
                  )}
                  <span className="due__title">{a.title}</span>
                  <span className="due__time">{hhmm(a.dueMin)}</span>
                </div>
              ))
            )}
          </section>

          {day.topThree.length > 0 && (
            <section className="rail__block">
              <h3 className="rail__title">Do these first</h3>
              {day.topThree.map((t) => (
                <div className="first" key={t.rank}>
                  <span className="first__rank">{t.rank}</span>
                  <span>
                    <span className="first__title">{t.title}</span>
                    <span className="first__why">
                      {t.course ? `${t.course} · ` : ""}{t.why}
                    </span>
                  </span>
                </div>
              ))}
            </section>
          )}

          <section className="rail__block rail__block--notes">
            <h3 className="rail__title">Notes</h3>
            <div className="notes-lines" aria-hidden="true" />
          </section>
        </aside>
      </div>

      {day.windows.length > 0 && (
        <section className="windows">
          <h3 className="col__title">Yours today — {formatDuration(day.freeMinutes)} across {day.windows.length} window{day.windows.length === 1 ? "" : "s"}</h3>
          <div className="windows__row">
            {day.windows.map((w) => (
              <span className={`window${w.bound ? " window--bound" : ""}`} key={w.time}>
                <span className="window__time">{w.time}</span>
                <span className="window__len">{formatDuration(w.minutes)}</span>
                <span className="window__tag">{w.label}</span>
              </span>
            ))}
          </div>
        </section>
      )}

      <Foot left={`${formatDuration(day.freeMinutes)} free · ${formatDuration(day.studyMinutes)} planned`} right={`${index + 1} / ${total}`} />
    </section>
  );
}

function WeekDots({ current }: { current: number }) {
  const letters = ["M", "TU", "W", "TH", "F", "SA", "SU"];
  return (
    <div className="dots" aria-hidden="true">
      {letters.map((l, i) => (
        <span key={l} className={`dot${i === current ? " dot--on" : ""}`}>{l}</span>
      ))}
    </div>
  );
}

function Column({ title, rows, hues }: { title: string; rows: DayRow[]; hues: Map<string, number> }) {
  return (
    <section className="col">
      <h3 className="col__title">{title}</h3>
      {rows.length === 0 && <p className="rail__empty">Nothing scheduled.</p>}
      {rows.map((r) => (
        <div className={`row${r.mine ? "" : " row--theirs"}${r.kind === "study" ? " row--study" : ""}`} key={r.id}>
          <span className="row__time" style={{ color: hue(hues, r.course) }}>{r.time}</span>
          <span className="row__body">
            <span className="row__title">{r.title}</span>
            {r.subtitle && <span className="row__sub">{r.subtitle}</span>}
            {!r.mine && r.pax && <span className="row__pax">for {r.pax} — not you</span>}
          </span>
          <span className="row__where">
            {r.location}
            {r.estimated && <abbr className="mark" title="The Matrix gave a start and no end; this length is an estimate.">≈</abbr>}
            {r.guessed && <abbr className="mark" title="Gemini was not confident; this was marked mandatory to be safe.">?</abbr>}
          </span>
        </div>
      ))}
      {/* A light day leaves most of the column empty. On a planner that space
          is not waste, it is where you write what you decided to do with it. */}
      <div className="col__fill" aria-hidden="true" />
    </section>
  );
}

/* --------------------------------------------------------------- courses */

export function CoursesSheet({ model, hues, page, total }: {
  model: DocumentModel; hues: Map<string, number>; page: number; total: number;
}) {
  return (
    <section className="page" aria-label="Courses and what is coming">
      <header className="crest crest--plain">
        <div className="crest__left">
          <h2 className="crest__day crest__day--sm">Courses &amp; what&rsquo;s coming</h2>
          <div className="crest__tag crest__tag--flat">
            {model.totalCredits} credits · {formatDuration(model.weeklyClassMinutes)} in class each week
          </div>
          <div className="crest__date">Registered schedule + Canvas beyond this week</div>
        </div>
      </header>

      <div className="course-grid">
        {model.courses.map((c) => <CourseCard key={c.code} c={c} hues={hues} />)}
        {model.courses.length === 0 && <p className="rail__empty">No semester schedule loaded.</p>}
      </div>

      <h3 className="band">Next three weeks</h3>
      {model.horizon.length === 0 && <p className="rail__empty">Nothing due in the next three weeks.</p>}
      {model.horizon.map((h) => (
        <div className="horizon" key={h.date}>
          <div className="horizon__when">
            <span className="horizon__day">{h.weekday}</span>
            <span className="horizon__date">{shortDate(h.date)}</span>
          </div>
          <div className="horizon__items">
            {h.items.map((a) => (
              <div className="horizon__item" key={a.id}>
                {a.courseCode && (
                  <span className="chip-code" style={{ color: hue(hues, a.courseCode), background: tint(hues, a.courseCode) }}>
                    {a.courseCode}
                  </span>
                )}
                <span>{a.title}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
      {model.beyondHorizon > 0 && (
        <p className="rail__empty">…and {model.beyondHorizon} more later in the term.</p>
      )}

      <Foot left="Registered schedule · Canvas export · weekly Matrix" right={`${page} / ${total}`} />
    </section>
  );
}

function CourseCard({ c, hues }: { c: CourseLine; hues: Map<string, number> }) {
  return (
    <div className="course" style={{ borderTopColor: hue(hues, c.code) }}>
      <div className="course__head">
        <span className="course__code" style={{ color: hue(hues, c.code) }}>{c.code}</span>
        {c.credits != null && <span className="course__cr">{c.credits} cr</span>}
      </div>
      <div className="course__title">{c.title}</div>
      <div className="course__meta">
        {[c.location, c.instructor].filter(Boolean).join(" | ") || "—"}
      </div>
      <div className="course__pattern">{c.pattern}</div>
      <div className="course__weekly">{formatDuration(c.weeklyMinutes)} a week</div>
    </div>
  );
}

/* ------------------------------------------------------------ study plan */

/**
 * Four rules, each one a finding rather than an opinion.
 *
 * They are on the page because a plan the cadet does not believe in is a plan
 * they abandon in week three, and "why is it spread out like this" deserves an
 * answer printed next to the schedule that answers it.
 */
const RULES: Array<{ head: string; body: string }> = [
  { head: "Spread, don't stack.", body: "Spaced study beats cramming for long-term retention even when the total time is identical." },
  { head: "Retrieve, don't reread.", body: "Practice testing and distributed practice rate high in the evidence; rereading and highlighting rate low." },
  { head: "Mix the problem sets.", body: "Interleaving feels worse while you practise and tests better afterwards." },
  { head: "Name the task, fix the time.", body: "If-then plans beat general intentions, which is why no block on these pages says “study”." },
];

export function StudySheet({ model, hues, page, total }: {
  model: DocumentModel; hues: Map<string, number>; page: number; total: number;
}) {
  const s: StudyPlan = model.study;
  const peak = Math.max(1, ...s.dailyLoad.map((d) => d.freeMinutes));
  const most = Math.max(1, ...s.perCourse.map((c) => c.minutes));

  return (
    <section className="page" aria-label="The study plan">
      <header className="crest crest--plain">
        <div className="crest__left">
          <h2 className="crest__day crest__day--sm">The study plan</h2>
          <div className="crest__tag crest__tag--flat">
            {formatDuration(s.totalMinutes)} this week · {s.sharePct}% of your free time · {s.blockCount} blocks
          </div>
          <div className="crest__date">Placed by code into gaps it verified — see the audit at the foot</div>
        </div>
      </header>

      <div className="study-grid">
        <section>
          <h3 className="band">Where the hours go</h3>
          {s.perCourse.length === 0 && <p className="rail__empty">No plan generated for this week yet.</p>}
          {s.perCourse.map((c) => (
            <div className="bar-row" key={c.code}>
              <span className="bar-row__code" style={{ color: hue(hues, c.code) }}>{c.code}</span>
              <span className="bar-row__title">{c.title}</span>
              <span className="bar-row__track">
                <span className="bar-row__fill" style={{ width: `${(c.minutes / most) * 100}%`, background: hue(hues, c.code) }} />
              </span>
              <span className="bar-row__num">{formatDuration(c.minutes)}</span>
              <span className="bar-row__days">{c.days}d</span>
            </div>
          ))}
        </section>

        <section>
          <h3 className="band">The four rules</h3>
          {RULES.map((r, i) => (
            <div className="rule" key={r.head}>
              <span className="rule__n">{i + 1}</span>
              <span>
                <span className="rule__head">{r.head}</span>
                <span className="rule__body">{r.body}</span>
              </span>
            </div>
          ))}
        </section>
      </div>

      <h3 className="band">Daily load — study against free time</h3>
      <div className="load">
        {s.dailyLoad.map((d) => (
          <div className="load__row" key={d.date}>
            <span className="load__day">{d.weekday}</span>
            <span className="load__track">
              <span className="load__free" style={{ width: `${(d.freeMinutes / peak) * 100}%` }} />
              <span className="load__study" style={{ width: `${(d.studyMinutes / peak) * 100}%` }} />
            </span>
            <span className="load__num">
              {formatDuration(d.studyMinutes)} of {formatDuration(d.freeMinutes)}
            </span>
          </div>
        ))}
      </div>

      <h3 className="band">Every session this week — {s.blockCount} blocks</h3>
      <div className="sessions">
        {s.sessions.map((d) => (
          <div className="sessions__day" key={d.date}>
            <div className="sessions__head">
              <span className="sessions__label">{d.weekday}</span>
              <span className="sessions__sum">{formatDuration(d.studyMinutes)}</span>
            </div>
            {d.blocks.length === 0 && <div className="sessions__none">—</div>}
            {d.blocks.map((b, i) => (
              <div className="sessions__row" key={`${d.date}-${i}`}>
                <span className="sessions__time" style={{ color: hue(hues, b.course) }}>{b.time}</span>
                <span className="sessions__course" style={{ color: hue(hues, b.course) }}>{b.course}</span>
                <span className="sessions__title">{b.title}</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      <section className="audit">
        <h3 className="audit__title">Audit — this run</h3>
        {model.audit.map((line) => <p key={line}>{line}</p>)}
      </section>

      <Foot left="Dunlosky et al. 2013 · Roediger &amp; Karpicke 2006 · Gollwitzer 1999" right={`${page} / ${total}`} />
    </section>
  );
}

function Foot({ left, right }: { left: string; right: string }) {
  return (
    <footer className="foot">
      <span>{left}</span>
      <span>{right}</span>
    </footer>
  );
}
