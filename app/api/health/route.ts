/**
 * Is this deployment able to talk to Gemini, and if not, what is missing?
 *
 * Reports enough to answer "is my environment variable actually live?" without
 * uploading a file and waiting to find out. A key set in a hosting dashboard
 * with a trailing newline, or pasted as an OAuth token rather than an API key,
 * is otherwise completely invisible until the first upload fails.
 */
import { checkKeyShape } from "@/lib/apikey";
import { MODEL_CHAINS, hasKey } from "@/lib/gemini";

export const runtime = "nodejs";

export async function GET() {
  const raw = process.env.GEMINI_API_KEY ?? "";
  const serverKey = hasKey();
  const shape = serverKey ? checkKeyShape(raw) : null;

  // Never the key, never a fragment of it that could be reassembled - only
  // whether it is the right shape and how long it is.
  const keyProblem = shape && !shape.ok ? shape.reason : null;
  const keyWarning = shape && shape.ok ? (shape.warning ?? null) : null;

  return Response.json({
    ok: serverKey && !keyProblem,
    keyConfigured: serverKey,
    /** When false, the browser must supply its own key with each request. */
    serverKey,
    /** Set when the server has a key but it cannot be an AI Studio key. */
    keyProblem,
    keyWarning,
    /** A key with whitespace round it is the classic dashboard paste mistake. */
    keyNeedsTrim: serverKey && raw !== raw.trim(),
    models: { parse: MODEL_CHAINS.parse, plan: MODEL_CHAINS.plan },
    hint: serverKey
      ? undefined
      : "No server key. Either set GEMINI_API_KEY in your hosting environment, " +
        "or paste a key on the Semester page - it stays in your browser.",
  });
}
