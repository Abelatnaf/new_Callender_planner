/**
 * A sample week.
 *
 * Opening the app for the first time lands on an empty state, which is an
 * honest but useless first impression: you cannot judge a planner with nothing
 * in it. This builds a plausible cadet week so the first click shows the thing
 * working — the grid, the capacity read, a real institutional conflict, and a
 * printable sheet.
 *
 * The matrix and course CSVs are day-of-week based, so they are week-agnostic.
 * The Canvas feed is generated against whichever week is being viewed, because
 * a demo whose deadlines sit in a fixed past week shows an empty column and
 * teaches you nothing.
 */

import { addDays, parseLocalDate, type LocalDate } from '../domain/time'
import { DEFAULT_PREFERENCES } from '../engine/solve'
import type { AppState } from '../store/state'
import { STATE_VERSION } from '../store/state'

export const SAMPLE_MATRIX = `CORPS OF CADETS - WEEKLY TRAINING SCHEDULE
Sample data - not a real published schedule
TIME;MON;TUE;WED;THU;FRI;SAT;SUN
0600-0630;;SRC / Class B;;SRC / Class B;;;
0630-0700;BRC Formation;BRC Formation;BRC Formation;BRC Formation;BRC Formation;;
0700-0730;Mess;Mess;Mess;Mess;Mess;Mess;Mess
0730-0930;;;;;;Parade (Class of '27 only);
1200-1245;Mess;Mess;Mess;Mess;Mess;Mess;Mess
1530-1700;;MAC Training - Band Co;MAC Training - Band Co;;;;
1730-1830;PT;;PT;;PT;;
1900-2100;SST;SST;SST;SST;;;
2300-0100;;;;;Guard @ Jackson Arch;;
`

export const SAMPLE_TERM = `course_code,section,title,days,start_time,end_time,location,instructor
CIS-111,01,Intro to Programming,MWF,08:00,08:50,Nichols 210,Ghani
CIS-111L,04,Intro to Programming Lab,W,14:00,16:50,Nichols 210,Ghani
ERH-101,04,Writing and Rhetoric,TR,14:00,15:20,Scott Shipp 300,Ramsey
MATH-121,02,Calculus I,MWF,10:00,10:50,Mallory 201,Hughes
HI-104,02,Modern World History,TR,09:30,10:50,Scott Shipp 212,Brodie
`

/** `YYYYMMDD` for a day offset from the week start. */
function stamp(weekStart: LocalDate, dayOffset: number): string {
  const { y, m, d } = parseLocalDate(addDays(weekStart, dayOffset))
  return `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`
}

/**
 * A Canvas feed for the given week.
 *
 * Deliberately includes the awkward cases, so the sample exercises the parser
 * rather than flattering it: a due date with no DTEND (the common case), an
 * all-day notice, a zoned meeting, a recurring recitation, and an exam that
 * occupies real time.
 */
export function buildSampleIcs(weekStart: LocalDate): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ORDER//Sample//EN',
    'CALSCALE:GREGORIAN',
    // Assignment deadlines: DTSTART only, which is how Canvas emits them.
    ...assignment('sample-1', stamp(weekStart, 2), '035900', 'Reading Response 2 [ERH-101-04]', 'Respond to the Gilgamesh excerpt in 500 words.'),
    ...assignment('sample-2', stamp(weekStart, 3), '035900', 'Research Paper Draft [ERH-101-04]'),
    ...assignment('sample-3', stamp(weekStart, 1), '155900', 'Problem Set 4 [CIS-111-01]'),
    ...assignment('sample-4', stamp(weekStart, 4), '155900', 'Chapter 12 Reading [HI-104-02]'),
    ...assignment('sample-5', stamp(weekStart, 7), '035900', 'Lab Report 3 [CIS-111L-04]'),
    // An all-day notice: no time, so it must not occupy any.
    'BEGIN:VEVENT',
    'UID:sample-holiday@order.local',
    `DTSTART;VALUE=DATE:${stamp(weekStart, 6)}`,
    'SUMMARY:Institute Holiday',
    'END:VEVENT',
    // A zoned meeting.
    'BEGIN:VEVENT',
    'UID:sample-conference@order.local',
    `DTSTART;TZID=America/New_York:${stamp(weekStart, 1)}T130000`,
    `DTEND;TZID=America/New_York:${stamp(weekStart, 1)}T132000`,
    'SUMMARY:ERH-101 Conference [ERH-101-04]',
    'LOCATION:Scott Shipp 300',
    'END:VEVENT',
    // An exam, which does occupy real time. Thursday 08:00-09:20: it ends
    // before the 09:30 lecture, and it is not in its own course's slot. Both
    // matter — an exam replacing a lecture, or clipping the next class by
    // twenty minutes, would surface as a conflict that is not really one, and
    // teach a first-time viewer the wrong thing about the banner.
    'BEGIN:VEVENT',
    'UID:sample-midterm@order.local',
    `DTSTART;TZID=America/New_York:${stamp(weekStart, 3)}T080000`,
    `DTEND;TZID=America/New_York:${stamp(weekStart, 3)}T092000`,
    'SUMMARY:CIS-111 Midterm Exam [CIS-111-01]',
    'LOCATION:Nichols 210',
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return lines.join('\r\n')
}

function assignment(uid: string, date: string, time: string, summary: string, description?: string): string[] {
  return [
    'BEGIN:VEVENT',
    `UID:${uid}@order.local`,
    `DTSTART:${date}T${time}Z`,
    `SUMMARY:${summary}`,
    ...(description ? [`DESCRIPTION:${description}`] : []),
    'END:VEVENT',
  ]
}

/**
 * A complete state for the sample week.
 *
 * The Wednesday collision is deliberate and authentic: the enrolled CIS-111L
 * lab meets 14:00-16:50 while Band Co MAC Training runs 15:30-17:00. This is
 * the exact case the spec singled out as one the app must surface rather than
 * silently resolve, and it is the most useful thing a first-time viewer can
 * see the planner do.
 *
 * The profile is set to a class year and company that the sample matrix
 * filters on, so the applicability filter visibly does something: the
 * Saturday parade is restricted to the class of '27 and is correctly left out
 * for a '28 cadet.
 */
export function buildSampleState(weekStart: LocalDate): AppState {
  const now = new Date().toISOString()
  return {
    version: STATE_VERSION,
    profile: { name: 'Sample cadet', classYear: '2028', company: 'Band' },
    preferences: DEFAULT_PREFERENCES,
    matrix: { filename: 'sample-matrix.csv', text: SAMPLE_MATRIX, receivedAt: now },
    term: { filename: 'sample-courses.csv', text: SAMPLE_TERM, receivedAt: now },
    canvas: { text: buildSampleIcs(weekStart), fetchedAt: now, label: 'Sample Canvas feed' },
    manualEvents: [],
    manualTasks: [
      {
        id: 'sample:rifle',
        title: 'Rifle inspection prep',
        dueAt: 4 * 1440 + 8 * 60,
        estimateMinutes: 90,
        estimateSource: 'user',
        chunks: [],
        status: 'todo',
        weight: 2,
      },
      {
        id: 'sample:math',
        title: 'MATH-121 problem set',
        course: 'MATH-121',
        dueAt: 3 * 1440 + 10 * 60,
        estimateMinutes: 150,
        estimateSource: 'user',
        chunks: [],
        status: 'todo',
        weight: 1,
      },
    ],
    taskOverrides: {},
    locks: {},
    selectedWeek: weekStart,
    theme: 'system',
  }
}
