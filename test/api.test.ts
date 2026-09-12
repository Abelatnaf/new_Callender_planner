/**
 * What the cadet reads when something fails.
 *
 * handleError is the entire error surface of this app: every route funnels
 * through it, and what it returns is what appears on the screen. The branch
 * ORDER is the load-bearing part — a rejected key arrives wrapped in a
 * ModelError, so the key branch has to run first or someone who mistyped a key
 * gets a page of Google's JSON instead of "that key was rejected".
 */
import { describe, expect, it } from "vitest";
import {
  MAX_UPLOAD_BYTES, fail, handleError, imageMime, isCsv, isImage, isPdf,
  isSpreadsheet, readUpload,
} from "@/lib/api";
import { MissingKeyError, ModelError, QuotaError } from "@/lib/gemini";

const body = async (r: Response) =>
  ({ status: r.status, ...(await r.json()) }) as {
    status: number; error: string; kind: string; detail?: string;
  };

describe("handleError", () => {
  it("asks for a key when there is none", async () => {
    const r = await body(handleError(new MissingKeyError()));
    expect(r.status).toBe(503);
    expect(r.kind).toBe("missing_key");
    expect(r.error).toMatch(/GEMINI_API_KEY/);
  });

  it("names the wait when Google said how long", async () => {
    const r = await body(handleError(new QuotaError(["gemini-flash-latest"], 27)));
    expect(r.status).toBe(429);
    expect(r.kind).toBe("rate_limit");
    expect(r.error).toMatch(/27 more seconds/);
    expect(r.error).toMatch(/nothing was lost/);
  });

  it("gets the singular right at one second", async () => {
    const r = await body(handleError(new QuotaError(["a"], 1)));
    expect(r.error).toMatch(/1 more second\b/);
  });

  it("points at the quota page when Google did not say", async () => {
    const r = await body(handleError(new QuotaError(["a", "b"], null)));
    expect(r.error).toMatch(/no allowance left/);
    expect(r.error).toMatch(/aistudio\.google\.com/);
  });

  it("lists every model it tried, so the message is checkable", async () => {
    const r = await body(handleError(new QuotaError(["gemini-flash-latest", "gemini-2.5-flash"], null)));
    expect(r.detail).toBe("Tried: gemini-flash-latest, gemini-2.5-flash.");
  });

  /* --------------------------------------------------------- branch order */

  it("names a rejected key even though it arrives wrapped in a ModelError", async () => {
    // The ordering bug this guards: ModelError is checked LAST for exactly
    // this reason. A typo in a pasted key is the likeliest failure of all.
    const wrapped = new ModelError(
      'got status: 400. {"error":{"status":"INVALID_ARGUMENT","message":"API key not valid. Please pass a valid API key."}}',
    );
    const r = await body(handleError(wrapped));
    expect(r.status).toBe(401);
    expect(r.kind).toBe("bad_key");
    expect(r.error).toMatch(/was rejected/);
    expect(r.error).not.toMatch(/INVALID_ARGUMENT/);
  });

  it("treats PERMISSION_DENIED as a key problem too", async () => {
    const r = await body(handleError(new Error("PERMISSION_DENIED: caller lacks permission")));
    expect(r.kind).toBe("bad_key");
  });

  it("recognises a bare quota message that never became a QuotaError", async () => {
    const r = await body(handleError(new Error("got status: 429. RESOURCE_EXHAUSTED")));
    expect(r.status).toBe(429);
    expect(r.kind).toBe("rate_limit");
  });

  it("passes a genuine model failure through as one", async () => {
    const r = await body(handleError(new ModelError("the model returned an empty response")));
    expect(r.status).toBe(502);
    expect(r.kind).toBe("model_error");
    expect(r.error).toMatch(/empty response/);
  });

  it("does not swallow an ordinary bug", async () => {
    const r = await body(handleError(new Error("cannot read properties of undefined")));
    expect(r.status).toBe(500);
    expect(r.kind).toBe("unknown");
    expect(r.error).toMatch(/cannot read properties/);
  });

  it("copes with something thrown that is not an Error at all", async () => {
    const r = await body(handleError("just a string"));
    expect(r.status).toBe(500);
    expect(r.error).toBe("just a string");
  });

  it("never returns an empty message", async () => {
    expect((await body(handleError(new Error("")))).error).toBe("Something went wrong.");
  });
});

describe("fail", () => {
  it("carries the status, kind and detail through", async () => {
    const r = await body(fail("nope", 422, "empty_file", "because"));
    expect(r).toMatchObject({ status: 422, error: "nope", kind: "empty_file", detail: "because" });
  });
});

/* ------------------------------------------------------------- the upload */

const form = (file?: File) => {
  const f = new FormData();
  if (file) f.set("file", file);
  return f;
};

describe("readUpload", () => {
  it("returns null when nothing was attached", async () => {
    expect(await readUpload(form())).toBeNull();
  });

  it("returns null for a zero-byte file rather than pretending it parsed", async () => {
    expect(await readUpload(form(new File([], "empty.csv", { type: "text/csv" })))).toBeNull();
  });

  it("hands back the name, type and bytes", async () => {
    const got = await readUpload(form(new File(["Time,PAX"], "Week03.csv", { type: "text/csv" })));
    expect(got?.name).toBe("Week03.csv");
    expect(got?.type).toBe("text/csv");
    expect(got?.bytes.toString("utf8")).toBe("Time,PAX");
  });

  it("refuses a file past the cap, and says how big it was", async () => {
    const big = new File(["x".repeat(MAX_UPLOAD_BYTES + 1)], "huge.csv", { type: "text/csv" });
    await expect(readUpload(form(big))).rejects.toThrow(/the limit is 12MB/);
  });

  it("ignores a plain string in the file field", async () => {
    const f = new FormData();
    f.set("file", "not a file");
    expect(await readUpload(f)).toBeNull();
  });
});

/* ------------------------------------------------- what kind of file is it */

describe("routing predicates", () => {
  it("knows a spreadsheet by extension or by type", () => {
    expect(isSpreadsheet("Matrix.xlsx", "")).toBe(true);
    expect(isSpreadsheet("Matrix.XLSM", "")).toBe(true);
    expect(isSpreadsheet("x", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe(true);
    expect(isSpreadsheet("Matrix.csv", "text/csv")).toBe(false);
  });

  it("knows a CSV, including the tab-separated cousin", () => {
    expect(isCsv("Week03.csv", "")).toBe(true);
    expect(isCsv("Week03.tsv", "")).toBe(true);
    expect(isCsv("download", "text/csv")).toBe(true);
    expect(isCsv("schedule.pdf", "application/pdf")).toBe(false);
  });

  it("knows a PDF", () => {
    expect(isPdf("schedule.PDF", "")).toBe(true);
    expect(isPdf("download", "application/pdf")).toBe(true);
    expect(isPdf("notes.txt", "text/plain")).toBe(false);
  });

  it("knows an image, which is how a schedule reaches a phone", () => {
    for (const n of ["s.png", "s.jpg", "s.jpeg", "s.webp", "s.HEIC"]) {
      expect(isImage(n, "")).toBe(true);
    }
    expect(isImage("download", "image/png")).toBe(true);
    expect(isImage("Week03.csv", "text/csv")).toBe(false);
  });

  it("picks a mime Gemini accepts, whatever the browser reported", () => {
    expect(imageMime("x.png", "image/png")).toBe("image/png");
    expect(imageMime("x.webp", "")).toBe("image/webp");
    expect(imageMime("x.png", "")).toBe("image/png");
    // HEIC and anything unrecognised fall back to jpeg rather than being sent
    // with a type the model will refuse outright.
    expect(imageMime("x.heic", "image/heic")).toBe("image/jpeg");
    expect(imageMime("screenshot", "")).toBe("image/jpeg");
  });
});
