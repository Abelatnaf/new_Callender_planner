/** Is this deployment able to talk to Gemini, and if not, what is missing? */
import { MODELS, hasKey } from "@/lib/gemini";

export const runtime = "nodejs";

export async function GET() {
  const serverKey = hasKey();
  return Response.json({
    ok: serverKey,
    keyConfigured: serverKey,
    /** When false, the browser must supply its own key with each request. */
    serverKey,
    models: MODELS,
    hint: serverKey
      ? undefined
      : "No server key. Either set GEMINI_API_KEY in your hosting environment, " +
        "or paste a key on the Semester page - it stays in your browser.",
  });
}
