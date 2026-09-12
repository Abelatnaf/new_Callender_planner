/**
 * Read a PDF's text layer, when it has one.
 *
 * The semester schedule arrives as a PDF, and there are two completely
 * different kinds. A print view carries real text: exact meeting times, rooms
 * and instructors, which can be read here in milliseconds and handed to the
 * model as characters. A screenshot saved as a PDF carries one JPEG and no
 * text at all, and the only way to read it is vision.
 *
 * Telling them apart matters: sending a text-bearing PDF to vision makes the
 * model infer "0800-0915" from where a box sits on a grid, when the document
 * said 0800-0915 in words all along.
 *
 * Server-side: uses node:zlib. Deliberately conservative — anything it is not
 * confident about comes back empty so the caller falls back to vision.
 */
import { inflateSync } from "node:zlib";

/** Adobe's ASCII85, as PDF writes it. */
function ascii85(input: string): Buffer {
  const src = input.replace(/\s+/g, "").replace(/^<~/, "").replace(/~>$/, "");
  const out: number[] = [];
  let tuple: number[] = [];
  for (const ch of src) {
    if (ch === "z" && tuple.length === 0) { out.push(0, 0, 0, 0); continue; }
    tuple.push(ch.charCodeAt(0) - 33);
    if (tuple.length === 5) {
      let n = 0;
      for (const d of tuple) n = n * 85 + d;
      out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
      tuple = [];
    }
  }
  if (tuple.length > 1) {
    const missing = 5 - tuple.length;
    for (let i = 0; i < missing; i++) tuple.push(84);
    let n = 0;
    for (const d of tuple) n = n * 85 + d;
    const full = [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
    out.push(...full.slice(0, 4 - missing));
  }
  return Buffer.from(out);
}

/** Every content stream we can decode, in file order. */
function contentStreams(pdf: Buffer): string[] {
  const text = pdf.toString("latin1");
  const out: string[] = [];

  for (const m of text.matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length;
    const end = text.indexOf("endstream", start);
    if (end === -1) continue;

    // The object dictionary immediately before this stream names its filters.
    const dict = text.slice(Math.max(0, m.index! - 400), m.index!);
    const raw = text.slice(start, end);

    let buf: Buffer | null = null;
    try {
      if (/ASCII85Decode/.test(dict)) {
        buf = inflateSync(ascii85(raw));
      } else if (/FlateDecode/.test(dict)) {
        buf = inflateSync(Buffer.from(raw, "latin1"));
      } else if (!/\/Filter/.test(dict)) {
        buf = Buffer.from(raw, "latin1");   // uncompressed content
      }
    } catch {
      continue;   // an image, an object stream, or something we cannot read
    }
    if (!buf) continue;

    const s = buf.toString("latin1");
    if (isContentStream(s)) out.push(s);
  }
  return out;
}

/**
 * Is this inflated stream page content, or a font or an image?
 *
 * Testing for "BT" and "Tj" alone is not enough: a compressed TrueType face or
 * a bitmap will contain those two byte pairs by coincidence, and inflating one
 * as if it were content yields thousands of characters of confident-looking
 * mojibake. Page content is a tiny operator language and is overwhelmingly
 * printable ASCII, so that is what is checked.
 */
function isContentStream(s: string): boolean {
  if (!/\bBT\b/.test(s) || !/\bET\b/.test(s) || !/\bTf\b/.test(s)) return false;
  const sample = s.slice(0, 4000);
  const printable = (sample.match(/[\x20-\x7E\r\n\t]/g) ?? []).length;
  return printable / sample.length > 0.9;
}

/** Unescape one PDF literal string. */
function literal(body: string): string {
  return body.replace(/\\(n|r|t|b|f|\(|\)|\\|[0-7]{1,3})/g, (_, e: string) => {
    switch (e) {
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "b": return "\b";
      case "f": return "\f";
      case "(": return "(";
      case ")": return ")";
      case "\\": return "\\";
      default: return String.fromCharCode(parseInt(e, 8));
    }
  });
}

function hexString(body: string): string {
  const hex = body.replace(/[^0-9a-fA-F]/g, "");
  let out = "";
  for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

/** Pull the shown strings out of one content stream, keeping line structure. */
function streamText(stream: string): string {
  const lines: string[] = [];
  let line = "";

  // Strings, and the operators that move the cursor to a new line.
  // T* is spelled out rather than folded into a character class: `*` is not a
  // word character, so a trailing \b after it can never hold and the standard
  // next-line operator would never match — running the whole document onto one
  // line, which is exactly what a schedule must not do.
  const token = /\((?:[^()\\]|\\.)*\)|<[0-9a-fA-F\s]*>|\bTd\b|\bTD\b|T\*|\bTJ\b|\bTj\b|\bET\b|'|"/g;
  for (const m of stream.matchAll(token)) {
    const t = m[0];
    if (t.startsWith("(")) line += literal(t.slice(1, -1));
    else if (t.startsWith("<")) line += hexString(t.slice(1, -1));
    else if (t === "Td" || t === "TD" || t === "T*" || t === "ET" || t === "'" || t === '"') {
      if (line.trim()) lines.push(line.trim());
      line = "";
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join("\n");
}

/**
 * Is this actually language, or a subset font's private encoding?
 *
 * A PDF may store text as codes that only its own embedded font can map back
 * to letters. Extracting those yields confident-looking gibberish, which is
 * worse than extracting nothing: the caller would skip vision and hand the
 * model nonsense. So anything that does not read as text is rejected.
 */
export function looksLikeRealText(s: string): boolean {
  const trimmed = s.trim();
  if (trimmed.length < 40) return false;
  const letters = (trimmed.match(/[A-Za-z]/g) ?? []).length;
  const printable = (trimmed.match(/[\x20-\x7E\n\t]/g) ?? []).length;
  if (printable / trimmed.length < 0.9) return false;
  if (letters / trimmed.length < 0.35) return false;
  // At least a few runs that look like words rather than isolated glyphs.
  return (trimmed.match(/\b[A-Za-z]{3,}\b/g) ?? []).length >= 5;
}

/**
 * The PDF's text, or "" when it has none worth using.
 *
 * An empty result is the signal to fall back to vision, and is the honest
 * answer for a scan, a screenshot saved as a PDF, or a subset encoding we
 * cannot map.
 */
export function extractPdfText(bytes: Buffer): string {
  let text: string;
  try {
    text = contentStreams(bytes)
      .map(streamText)
      .filter((t) => t.trim().length > 0 && looksLikeRealText(t))
      .join("\n");
  } catch {
    return "";
  }
  const cleaned = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return looksLikeRealText(cleaned) ? cleaned : "";
}
