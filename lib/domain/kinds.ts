/**
 * `Kind` is the single source of truth for how a block behaves in the solver
 * and how it reads on the page.
 *
 * The print rule that drives this table
 * -------------------------------------
 * The deliverable is a sheet of paper out of a tired barracks printer, quite
 * possibly greyscale. So a kind is NEVER encoded in colour alone. Every kind
 * carries three redundant channels:
 *
 *   1. `accent`   — hue, for the screen
 *   2. `glyph`    — a single character, survives greyscale and colour-blindness
 *   3. `texture`  — fill pattern, survives photocopying
 *
 * Plus the one invariant that matters most, orthogonal to kind: blocks the
 * Institute decided render SOLID, blocks the app decided render with a dashed
 * leading edge. At a glance you must be able to tell an order from a
 * suggestion.
 */

export const KINDS = [
  'formation',
  'parade',
  'duty',
  'inspection',
  'class',
  'lab',
  'pt',
  'athletics',
  'meal',
  'taps',
  'study',
  'assignment_due',
  'exam',
  'travel',
  'personal',
  'recharge',
  'open',
] as const

export type Kind = (typeof KINDS)[number]

/** Which of the five Atelier accents a kind draws from. */
export type Accent = 'terracotta' | 'sky' | 'ochre' | 'sage' | 'lavender' | 'ink'

export type Texture = 'solid' | 'hatch' | 'dots' | 'none'

export interface KindSpec {
  kind: Kind
  label: string
  accent: Accent
  /** One character. Must be legible at 7pt in a 3mm box. */
  glyph: string
  texture: Texture
  /** Immovable by default — the solver treats these as walls. */
  hard: boolean
  /** Does this occupy time, or is it only a marker on the page? */
  occupiesTime: boolean
  /** Ranking when two hard things collide and we must report the conflict. */
  authority: number
}

const SPECS: Record<Kind, KindSpec> = {
  // ---- Corps mandatory. The Institute decided. Terracotta, highest authority.
  formation:      { kind: 'formation',      label: 'Formation',   accent: 'terracotta', glyph: 'F', texture: 'solid', hard: true,  occupiesTime: true,  authority: 100 },
  parade:         { kind: 'parade',         label: 'Parade',      accent: 'terracotta', glyph: 'P', texture: 'solid', hard: true,  occupiesTime: true,  authority: 100 },
  duty:           { kind: 'duty',           label: 'Duty',        accent: 'terracotta', glyph: 'D', texture: 'solid', hard: true,  occupiesTime: true,  authority: 95 },
  inspection:     { kind: 'inspection',     label: 'Inspection',  accent: 'terracotta', glyph: 'I', texture: 'solid', hard: true,  occupiesTime: true,  authority: 95 },
  taps:           { kind: 'taps',           label: 'Taps',        accent: 'terracotta', glyph: 'T', texture: 'hatch', hard: true,  occupiesTime: true,  authority: 90 },

  // ---- Academics. You enrolled. Dusty sky.
  class:          { kind: 'class',          label: 'Class',       accent: 'sky',        glyph: 'C', texture: 'solid', hard: true,  occupiesTime: true,  authority: 80 },
  lab:            { kind: 'lab',            label: 'Lab',         accent: 'sky',        glyph: 'L', texture: 'solid', hard: true,  occupiesTime: true,  authority: 80 },

  // ---- Bodies and movement.
  pt:             { kind: 'pt',             label: 'PT',          accent: 'sage',       glyph: 'X', texture: 'solid', hard: true,  occupiesTime: true,  authority: 70 },
  athletics:      { kind: 'athletics',      label: 'Athletics',   accent: 'sage',       glyph: 'A', texture: 'solid', hard: true,  occupiesTime: true,  authority: 70 },
  travel:         { kind: 'travel',         label: 'Travel',      accent: 'lavender',   glyph: '>', texture: 'hatch', hard: true,  occupiesTime: true,  authority: 60 },
  meal:           { kind: 'meal',           label: 'Meal',        accent: 'ochre',      glyph: 'M', texture: 'dots',  hard: true,  occupiesTime: true,  authority: 50 },

  // ---- Deadlines. Markers, not blocks. Sun ochre.
  assignment_due: { kind: 'assignment_due', label: 'Due',         accent: 'ochre',      glyph: '!', texture: 'none',  hard: false, occupiesTime: false, authority: 40 },
  exam:           { kind: 'exam',           label: 'Exam',        accent: 'ochre',      glyph: 'E', texture: 'solid', hard: true,  occupiesTime: true,  authority: 85 },

  // ---- What the app decided. Sage. Always dashed-edge.
  study:          { kind: 'study',          label: 'Study',       accent: 'sage',       glyph: 'S', texture: 'solid', hard: false, occupiesTime: true,  authority: 20 },
  recharge:       { kind: 'recharge',       label: 'Recharge',    accent: 'lavender',   glyph: 'R', texture: 'dots',  hard: false, occupiesTime: true,  authority: 10 },

  // ---- Yours.
  personal:       { kind: 'personal',       label: 'Personal',    accent: 'lavender',   glyph: 'O', texture: 'solid', hard: true,  occupiesTime: true,  authority: 30 },
  open:           { kind: 'open',           label: 'Open',        accent: 'ink',        glyph: '·', texture: 'none',  hard: false, occupiesTime: false, authority: 0 },
}

export function kindSpec(kind: Kind): KindSpec {
  return SPECS[kind]
}

export function isKind(value: string): value is Kind {
  return (KINDS as readonly string[]).includes(value)
}

/**
 * Best-effort classification of a free-text activity name from the matrix.
 *
 * Ordered longest-phrase-first so `parade prep` does not match `parade`, and
 * so `BRC formation` lands on formation rather than falling through. Every rule
 * is a whole-word match to stop `lab` matching `Labor Day`.
 */
const CLASSIFIERS: ReadonlyArray<readonly [RegExp, Kind]> = [
  // The bare word "inspection" is a real gap the jargon-only list above
  // missed: a title literally named "Inspection Platoon" fell through every
  // rule to the 'personal' default, which meant it never outranked anything
  // it collided with — a plain inspection lost a conflict against a lunch
  // block. Widening this one rule, not narrowing any other, so it cannot
  // shadow a later rule's match.
  [/\b(srb|src|sri|room\s*inspection|in[\s-]?ranks|rack\s*inspection|inspection)\b/i, 'inspection'],
  [/\b(brc|erc|trc|formation|accountability|roll\s*call)\b/i, 'formation'],
  [/\b(parade|review|retreat\s*ceremony|pass\s*in\s*review)\b/i, 'parade'],
  [/\b(guard|cq|charge\s*of\s*quarters|duty|watch|orderly)\b/i, 'duty'],
  [/\b(taps|lights\s*out|all\s*in|sleep)\b/i, 'taps'],
  [/\b(mess|chow|breakfast|lunch|dinner|supper|meal)\b/i, 'meal'],
  [/\b(pt|physical\s*training|vfit|fitness\s*test|apft)\b/i, 'pt'],
  [/\b(practice|team|intramural|athletics|corps\s*squad)\b/i, 'athletics'],
  [/\b(lab|laboratory|studio)\b/i, 'lab'],
  [/\b(class|lecture|recitation|seminar|mac\s*training|rotc|leadership\s*lab)\b/i, 'class'],
  [/\b(exam|final|midterm|quiz|test)\b/i, 'exam'],
  [/\b(travel|transit|bus|convoy|movement)\b/i, 'travel'],
  [/\b(study|sst|call\s*to\s*quarters\s*study|academic\s*hour)\b/i, 'study'],
]

export function classifyActivity(title: string): Kind {
  for (const [pattern, kind] of CLASSIFIERS) {
    if (pattern.test(title)) return kind
  }
  return 'personal'
}
