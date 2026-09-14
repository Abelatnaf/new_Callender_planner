import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCsv, sniffDelimiter } from '@/lib/parse/csv'
import { detectMatrix, parseAppliesTo, parseCell, parseMatrix } from '@/lib/parse/matrix'
import { parseClock, parseDayCodes, parseTimeRange } from '@/lib/parse/timeRange'
import { atDay, dayOf, formatClock, spanLength } from '@/lib/domain/time'

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8')

describe('clock parsing', () => {
  it('reads military, colon, and bare-hour forms', () => {
    expect(parseClock('0700')).toBe(7 * 60)
    expect(parseClock('07:00')).toBe(7 * 60)
    expect(parseClock('7:00')).toBe(7 * 60)
    expect(parseClock('7')).toBe(7 * 60)
    expect(parseClock('1430')).toBe(14 * 60 + 30)
    expect(parseClock('700')).toBe(7 * 60)
  })

  it('reads meridiem forms including noon and midnight', () => {
    expect(parseClock('7:00 PM')).toBe(19 * 60)
    expect(parseClock('7 pm')).toBe(19 * 60)
    expect(parseClock('12:00 AM')).toBe(0)
    expect(parseClock('12:00 PM')).toBe(12 * 60)
  })

  it('treats 2400 as end-of-day, not hour 24', () => {
    expect(parseClock('2400')).toBe(1440)
    expect(parseClock('0000')).toBe(0)
  })

  it('tolerates trailing hrs and dot separators', () => {
    expect(parseClock('0700hrs')).toBe(7 * 60)
    expect(parseClock('07.00')).toBe(7 * 60)
  })

  it('rejects nonsense rather than guessing', () => {
    expect(parseClock('abc')).toBeNull()
    expect(parseClock('25:00')).toBeNull()
    expect(parseClock('07:75')).toBeNull()
    expect(parseClock('')).toBeNull()
  })
})

describe('time range parsing', () => {
  it('reads every dash the source file might contain', () => {
    for (const text of ['0600-0630', '06:00-06:30', '0600–0630', '0600 — 0630', '0600 to 0630']) {
      const r = parseTimeRange(text)
      expect(r, text).not.toBeNull()
      expect(r?.start).toBe(6 * 60)
      expect(r?.end).toBe(6 * 60 + 30)
    }
  })

  it('flags a range that crosses midnight instead of inverting it', () => {
    const r = parseTimeRange('2300-0100')
    expect(r?.crossesMidnight).toBe(true)
    expect(r?.start).toBe(23 * 60)
    expect(r?.end).toBe(25 * 60) // 01:00 the next day
  })

  it('inherits the meridiem of the start when the end omits it', () => {
    const r = parseTimeRange('6:00 PM - 7:30')
    expect(r?.start).toBe(18 * 60)
    expect(r?.end).toBe(19 * 60 + 30)
  })

  it('gives an open-ended start a default length', () => {
    const r = parseTimeRange('1900', 45)
    expect(r?.start).toBe(19 * 60)
    expect(r?.end).toBe(19 * 60 + 45)
  })

  /**
   * Regression: a bare "2400" (real schedules write Taps this way) parses to
   * start===end===1440, and spansFor() silently drops anything with
   * end <= start. Three Taps entries a week vanished with no warning at all —
   * the worst kind of bug, because nothing looked wrong. It now extends
   * backward instead of forward when there is no room left in the day.
   */
  it('gives a bare "2400" real duration instead of silently vanishing', () => {
    const r = parseTimeRange('2400', 30)
    expect(r?.end).toBe(24 * 60)
    expect(r!.end).toBeGreaterThan(r!.start)
    expect(r?.start).toBe(24 * 60 - 30)
  })
})

describe('compact day codes', () => {
  it('expands registrar shorthand', () => {
    expect(parseDayCodes('MWF')).toEqual([0, 2, 4])
    expect(parseDayCodes('TR')).toEqual([1, 3])
    expect(parseDayCodes('MTWRF')).toEqual([0, 1, 2, 3, 4])
  })

  it('reads delimited and long forms', () => {
    expect(parseDayCodes('MO,WE,FR')).toEqual([0, 2, 4])
    expect(parseDayCodes('Monday')).toEqual([0])
    expect(parseDayCodes('M/W/F')).toEqual([0, 2, 4])
  })

  it('returns nothing for an unreadable cell instead of a wrong day', () => {
    expect(parseDayCodes('someday')).toEqual([])
    expect(parseDayCodes('')).toEqual([])
  })
})

describe('CSV tolerance', () => {
  it('sniffs a semicolon file over a comma one', () => {
    expect(sniffDelimiter('a;b;c\n1;2;3')).toBe(';')
    expect(sniffDelimiter('a,b,c\n1,2,3')).toBe(',')
    expect(sniffDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t')
  })

  it('strips the BOM and skips a decorative title block', () => {
    const table = parseCsv(fixture('matrix-wide.csv'))
    expect(table.header[0]).toBe('TIME')
    expect(table.delimiter).toBe(';')
    expect(table.skippedPreamble.length).toBeGreaterThan(0)
    expect(table.warnings.some((w) => w.includes('decorative'))).toBe(true)
  })

  it('honours quoted fields containing the delimiter', () => {
    const table = parseCsv('a,b\n"one, two",three')
    expect(table.rows[0]).toEqual(['one, two', 'three'])
  })

  it('survives an unbalanced quote without swallowing the file', () => {
    const table = parseCsv('Day,Activity\nMonday,"Parade\nTuesday,Formation')
    expect(table.warnings.some((w) => w.includes('never closed'))).toBe(true)
    expect(table.rows.length).toBeGreaterThanOrEqual(2)
  })

  it('pads short rows and keeps data from over-long ones', () => {
    const table = parseCsv('a,b,c\n1,2\n1,2,3,4')
    // Every row is rectangular...
    const width = table.header.length
    expect(table.rows.every((r) => r.length === width)).toBe(true)
    // ...and the extra column was kept, not dropped, because losing a column
    // of a schedule silently is worse than showing an unnamed one.
    expect(width).toBe(4)
    expect(table.header[3]).toBe('Column 4')
    expect(table.rows[1]?.[3]).toBe('4')
    expect(table.warnings.some((w) => w.includes('more columns than the header'))).toBe(true)
  })
})

describe('matrix cell content', () => {
  it('splits a uniform off the title', () => {
    const cell = parseCell('SRC / Class B')
    expect(cell.title).toBe('SRC')
    expect(cell.uniform).toBe('Class B')
  })

  it('reads a class-year restriction out of a parenthetical', () => {
    const cell = parseCell("Parade (Class of '27 only)")
    expect(cell.title).toBe('Parade')
    expect(cell.appliesTo?.classYears).toEqual(['2027'])
  })

  it('reads a company restriction', () => {
    const cell = parseCell('MAC Training - Band Co')
    expect(cell.title).toBe('MAC Training')
    expect(cell.appliesTo?.companies).toEqual(['Band'])
  })

  it('reads a location after an at-sign', () => {
    const cell = parseCell('Guard Mount @ Jackson Arch')
    expect(cell.title).toBe('Guard Mount')
    expect(cell.location).toBe('Jackson Arch')
  })

  it('lets an inline time override the row period', () => {
    const cell = parseCell('Drill 1500-1600')
    expect(cell.timeOverride).toEqual({ start: 15 * 60, end: 16 * 60 })
  })

  it('does not invent an event from a placeholder cell', () => {
    // `N/A` is the trap: `/` is also the uniform separator, so a naive split
    // turns this cell into an event titled "N".
    for (const blank of ['-', '--', '---', 'N/A', 'n/a', 'none', 'nil', '—', '·', '']) {
      expect(parseCell(blank).title, blank).toBe('')
    }
  })

  /**
   * A real published VMI schedule uses ordinal class rank (1/C .. 4/C), not a
   * graduation year, for who a formation applies to. This is genuinely
   * different vocabulary from `CLASS_YEAR` and has to be read on its own.
   */
  it('reads ordinal class rank as an applicability filter', () => {
    expect(parseAppliesTo('2/C Cadet Leaders')?.classYears).toEqual(['2C'])
    expect(parseAppliesTo('1/C')?.classYears).toEqual(['1C'])
    expect(parseAppliesTo('3/C')?.classYears).toEqual(['3C'])
  })

  it('folds "4/C" into the same RAT population the word "Rats" names', () => {
    expect(parseAppliesTo('4/C')?.classYears).toEqual(['RAT'])
  })

  /**
   * Regression: "Rats and Cadre" was being narrowed to rats only, because the
   * gate that triggers class-year extraction fires on the mere presence of
   * the word "rats" anywhere in the text. That silently hid the event from
   * every cadre member reading their own plan — the opposite of what the
   * phrase says. Real published schedules say this every single day.
   */
  it('does not narrow "Rats and Cadre" to rats alone', () => {
    expect(parseAppliesTo('Rats and Cadre')).toBeUndefined()
  })

  it('still restricts a bare "Rats" to rats only', () => {
    expect(parseAppliesTo('Rats')?.classYears).toEqual(['RAT'])
    expect(parseAppliesTo('Rats only')?.classYears).toEqual(['RAT'])
  })

  it('treats "Corps (-)" as applying to everyone, like "Corps" alone', () => {
    expect(parseAppliesTo('Corps (-)')).toBeUndefined()
    expect(parseAppliesTo('Corps(-)')).toBeUndefined()
  })

  it('treats "All" as applying to everyone, not as a restriction', () => {
    expect(parseAppliesTo('All')).toBeUndefined()
    expect(parseAppliesTo('')).toBeUndefined()
  })
})

describe('Shape A — the wide grid', () => {
  const detection = detectMatrix(fixture('matrix-wide.csv'))

  it('detects the grid and locates the time column', () => {
    expect(detection.shape).toBe('wide')
    expect(detection.wide?.timeColumn).toBe(0)
    expect(detection.wide?.dayColumns).toHaveLength(7)
  })

  it('melts day columns into dated events', () => {
    const { events } = parseMatrix(detection, { classYear: '2028', company: 'Band' })
    expect(events.length).toBeGreaterThan(10)
    const monday = events.filter((e) => dayOf(e.span.start) === 0)
    expect(monday.some((e) => e.title === 'BRC Formation')).toBe(true)
  })

  it('classifies activities into kinds without being told', () => {
    const { events } = parseMatrix(detection, { classYear: '2028', company: 'Band' })
    expect(events.find((e) => e.title === 'BRC Formation')?.kind).toBe('formation')
    expect(events.find((e) => e.title === 'Mess')?.kind).toBe('meal')
    expect(events.find((e) => e.title === 'SST')?.kind).toBe('study')
    expect(events.find((e) => e.title.startsWith('Guard'))?.kind).toBe('duty')
  })

  it('carries the uniform through from the cell', () => {
    const { events } = parseMatrix(detection, { classYear: '2028', company: 'Band' })
    expect(events.find((e) => e.title === 'SRC')?.uniform).toBe('Class B')
  })

  it('reads an en-dash time range', () => {
    const { events } = parseMatrix(detection, { classYear: '2028', company: 'Band' })
    const lunch = events.filter((e) => e.title === 'Mess' && formatClock(e.span.start) === '12:00')
    expect(lunch.length).toBe(7)
    expect(spanLength(lunch[0]!.span)).toBe(45)
  })

  it('drops a parade restricted to another class year', () => {
    const mine = parseMatrix(detection, { classYear: '2028', company: 'Band' })
    expect(mine.events.some((e) => e.title === 'Parade')).toBe(false)
    expect(mine.warnings.some((w) => w.includes('another class year'))).toBe(true)

    const theirs = parseMatrix(detection, { classYear: '2027', company: 'Band' })
    expect(theirs.events.some((e) => e.title === 'Parade')).toBe(true)
  })

  it('drops another company training', () => {
    const alpha = parseMatrix(detection, { classYear: '2028', company: 'A' })
    expect(alpha.events.some((e) => e.title === 'MAC Training')).toBe(false)
  })

  it('emits nothing for the all-placeholder row', () => {
    const { events } = parseMatrix(detection, { classYear: '2028', company: 'Band' })
    expect(events.some((e) => ['-', '--', '—'].includes(e.title))).toBe(false)
  })

  it('keeps the raw cells so a parser fix can be replayed', () => {
    const { events } = parseMatrix(detection, { classYear: '2028', company: 'Band' })
    expect(events[0]?.raw).toBeDefined()
    expect(Object.keys(events[0]?.raw ?? {})).toContain('cell')
  })
})

describe('Shape B — the tidy table', () => {
  const detection = detectMatrix(fixture('matrix-long.csv'))

  it('detects the tidy shape and proposes a mapping', () => {
    expect(detection.shape).toBe('long')
    expect(detection.suggestedMapping?.['Activity']).toBe('activity')
    expect(detection.suggestedMapping?.['Start']).toBe('start')
    expect(detection.suggestedMapping?.['Applies To']).toBe('applies_to')
  })

  it('fingerprints the header so the mapping can be remembered', () => {
    expect(detection.headerFingerprint).toHaveLength(8)
    const again = detectMatrix(fixture('matrix-long.csv'))
    expect(again.headerFingerprint).toBe(detection.headerFingerprint)
  })

  it('expands a compact day code into one event per day', () => {
    const { events } = parseMatrix(detection, { classYear: '2028', company: 'Band' })
    const lecture = events.filter((e) => e.title === 'CIS-111 Lecture')
    expect(lecture.map((e) => dayOf(e.span.start))).toEqual([0, 2, 4])
  })

  it('handles a range that crosses midnight', () => {
    const { events } = parseMatrix(detection, { classYear: '2028', company: 'Band' })
    const guard = events.find((e) => e.title === 'Guard Duty')
    expect(guard).toBeDefined()
    expect(guard!.span.start).toBe(atDay(4, 23 * 60))
    expect(guard!.span.end).toBe(atDay(5, 60))
  })

  it('rejects a row with no readable time and says which', () => {
    const { rejected } = parseMatrix(detection, { classYear: '2028', company: 'Band' })
    expect(rejected.some((r) => r.why.includes('time'))).toBe(true)
  })

  it('surfaces the institutional lab/training overlap rather than hiding it', () => {
    const { events } = parseMatrix(detection, { classYear: '2028', company: 'Band' })
    const lab = events.find((e) => e.title === 'CIS-111L Lab')
    const mac = events.find((e) => e.title === 'MAC Training')
    expect(lab).toBeDefined()
    expect(mac).toBeDefined()
    expect(lab!.span.start < mac!.span.end && mac!.span.start < lab!.span.end).toBe(true)
  })
})

describe('a merged title banner is not a header', () => {
  /**
   * A title merged across A1:H1 is one cell to a human and, once the merge is
   * expanded for the parser, eight identical cells. That passes a naive "at
   * least two non-empty cells" header test and gets chosen as the header —
   * leaving the real header treated as data and the file unreadable. This is
   * the commonest shape in a published schedule, so it needs an assertion.
   */
  it('skips a row whose every cell is the same value', () => {
    const csv = [
      'CORPS SCHEDULE,CORPS SCHEDULE,CORPS SCHEDULE,CORPS SCHEDULE',
      'Effective now,Effective now,Effective now,Effective now',
      'TIME,MON,TUE,WED',
      '0700-0730,BRC,BRC,BRC',
    ].join('\n')

    const table = parseCsv(csv)
    expect(table.header).toEqual(['TIME', 'MON', 'TUE', 'WED'])
    expect(table.skippedPreamble).toHaveLength(2)
  })

  it('still accepts a header that happens to repeat one name', () => {
    // Distinct columns, one duplicate — a real header, not a banner.
    const table = parseCsv('Day,Activity,Activity\nMonday,BRC,SRC')
    expect(table.header).toEqual(['Day', 'Activity', 'Activity'])
  })

  it('detects the grid shape through a merged banner', () => {
    const csv = [
      'WEEKLY TRAINING,WEEKLY TRAINING,WEEKLY TRAINING,WEEKLY TRAINING,WEEKLY TRAINING',
      'TIME,MON,TUE,WED,THU',
      '0700-0730,BRC Formation,BRC Formation,BRC Formation,BRC Formation',
    ].join('\n')
    expect(detectMatrix(csv).shape).toBe('wide')
  })
})
