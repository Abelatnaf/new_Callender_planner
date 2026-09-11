/**
 * What did the cadet just drop on us?
 *
 * Three files arrive each term or week and they are easy to mix up: the Canvas
 * feed, the Matrix, and the semester schedule. Making the cadet remember which
 * box each one belongs in is a needless way to fail, so the file itself decides
 * wherever it can, and the drop zone only decides what the file genuinely
 * leaves ambiguous.
 *
 * Detection reads the head of the file rather than trusting the extension. A
 * Canvas feed saved as `calendar.txt` is still a Canvas feed.
 */

export type FileKind = "canvas" | "matrix" | "image" | "pdf" | "sheet" | "text" | "empty";

/** Where a file belongs, when the file settles it. Null means the zone decides. */
export type Destination = "canvas" | "matrix" | "term";

export type Detection = {
  kind: FileKind;
  destination: Destination | null;
  /** One clause, so a file routed somewhere the cadet did not drop it says why. */
  because: string;
};

/** How much of the file to look at. Enough for a header block, cheap on a 2.4MB Matrix. */
export const SNIFF_BYTES = 8192;

const IMAGE_EXT = /\.(png|jpe?g|webp|heic|gif|bmp)$/i;
const SHEET_EXT = /\.(xlsx|xlsm|xls|csv|tsv)$/i;

/**
 * The Matrix's own column header: `Time | PAX | Event | Location | Uniform |
 * Instructor`. PAX is the giveaway - no registrar schedule has a column saying
 * which body of cadets an event is for.
 */
export function looksLikeMatrix(head: string): boolean {
  if (!/(^|[,\t;"\s])pax([,\t;"\s]|$)/i.test(head)) return false;
  const companions = ["time", "event", "location", "uniform", "instructor"].filter((w) =>
    new RegExp(`(^|[,\\t;"])\\s*${w}\\s*([,\\t;"]|$)`, "im").test(head),
  );
  return companions.length >= 2;
}

/** An iCalendar feed, whatever it happens to be named. */
export function looksLikeCalendar(head: string): boolean {
  return /BEGIN\s*:\s*VCALENDAR/i.test(head);
}

/**
 * Classify from the name, the reported type, and the first few KB.
 *
 * Pure, so the routing rules can be tested without a browser.
 */
export function classifyContent(opts: { name: string; type: string; head: string }): Detection {
  const { name, type, head } = opts;

  // Content first. An .ics renamed, re-saved or served as text/plain is still
  // the Canvas feed, and getting this wrong sends a term of deadlines nowhere.
  if (looksLikeCalendar(head)) {
    return { kind: "canvas", destination: "canvas", because: "it is an iCalendar feed" };
  }
  if (/\.ics$/i.test(name) || /text\/calendar/i.test(type)) {
    return { kind: "canvas", destination: "canvas", because: "it is a .ics calendar file" };
  }
  if (looksLikeMatrix(head)) {
    return { kind: "matrix", destination: "matrix", because: "it has the Matrix's Time/PAX/Event columns" };
  }

  // Beyond here the file cannot say which importer wants it - a screenshot may
  // be the semester schedule or the Matrix, and a spreadsheet may be either.
  if (IMAGE_EXT.test(name) || /^image\//i.test(type)) {
    return { kind: "image", destination: null, because: "it is an image" };
  }
  if (/\.pdf$/i.test(name) || type === "application/pdf" || /^%PDF-/.test(head)) {
    return { kind: "pdf", destination: null, because: "it is a PDF" };
  }
  if (SHEET_EXT.test(name) || /spreadsheet|excel|csv|tab-separated/i.test(type) || /^PK\x03\x04/.test(head)) {
    return { kind: "sheet", destination: null, because: "it is a spreadsheet" };
  }
  if (!head.trim()) return { kind: "empty", destination: null, because: "it is empty" };
  return { kind: "text", destination: null, because: "it is plain text" };
}

/** Read the head of a file and classify it. Browser-side. */
export async function detectFile(file: File): Promise<Detection> {
  let head = "";
  try {
    head = await file.slice(0, SNIFF_BYTES).text();
  } catch {
    /* unreadable head; fall back to the name and type alone */
  }
  return classifyContent({ name: file.name || "", type: file.type || "", head });
}

/**
 * Resolve a detection against the zone it was dropped on.
 *
 * `moved` is true when the file is going somewhere other than where it landed,
 * which is the case worth telling the cadet about.
 */
export function routeTo(
  detection: Detection,
  zone: Destination,
): { destination: Destination; moved: boolean; because: string } {
  const destination = detection.destination ?? zone;
  return { destination, moved: destination !== zone, because: detection.because };
}
