import { SettingsSchema, type Assignment, type MatrixEvent, type Settings, type Term } from "@/lib/schemas";

export const settings: Settings = SettingsSchema.parse({});

/** Monday 2026-09-07 through Sunday 2026-09-13. */
export const MONDAY = "2026-09-07";
export const TUESDAY = "2026-09-08";

export const term: Term = {
  id: "T1",
  name: "Fall 2026",
  startDate: "2026-08-17",
  endDate: "2026-12-11",
  courses: [
    {
      id: "C1", code: "CHEM 141", title: "General Chemistry",
      meetings: [{ days: ["MO", "WE", "FR"], startMin: 480, endMin: 530, location: "MI 302" }],
    },
    {
      id: "C2", code: "MATH 171", title: "Calculus I",
      meetings: [{ days: ["MO", "WE", "FR"], startMin: 540, endMin: 590, location: "MA 214" }],
    },
    {
      id: "C3", code: "HI 104", title: "Modern World History",
      meetings: [{ days: ["MO", "WE"], startMin: 810, endMin: 860, location: "SC 121" }],
    },
  ],
};

/** A representative VMI Monday. */
export const matrixEvents: MatrixEvent[] = [
  ev("M1", "BRC", MONDAY, 390, 420, "formation", "BLOCKED"),
  ev("M2", "DRC", MONDAY, 730, 760, "formation", "BLOCKED"),
  ev("M3", "Corps Athletics", MONDAY, 960, 1050, "athletics", "BLOCKED"),
  ev("M4", "SRC", MONDAY, 1095, 1125, "formation", "BLOCKED"),
  ev("M5", "CQ", MONDAY, 1170, 1350, "study", "PARTIAL"),
];

function ev(
  id: string, title: string, date: string, startMin: number, endMin: number,
  kind: MatrixEvent["kind"], availability: MatrixEvent["availability"],
): MatrixEvent {
  return {
    id, title, raw: title, date, startMin, endMin, kind, availability,
    confidence: 0.95, confirmedByUser: false, ratcheted: false,
  };
}
export { ev };

export const assignments: Assignment[] = [
  {
    id: "A1", title: "Problem Set 4", courseCode: "MATH 171",
    dueDate: TUESDAY, dueMin: 480, kind: "problem_set",
    status: "todo", source: "canvas",
  },
  {
    id: "A2", title: "Lab Report 2", courseCode: "CHEM 141",
    dueDate: "2026-09-11", dueMin: 1380, kind: "lab",
    status: "todo", source: "canvas",
  },
  {
    id: "A3", title: "Reading: Ch. 7", courseCode: "HI 104",
    dueDate: MONDAY, dueMin: 810, kind: "reading",
    status: "todo", source: "canvas",
  },
];
