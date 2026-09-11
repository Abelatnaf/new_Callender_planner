/** Is this deployment actually able to talk to Gemini? */
import { MODELS, hasKey } from "@/lib/gemini";

export const runtime = "nodejs";

export async function GET() {
  return Response.json({
    ok: hasKey(),
    keyConfigured: hasKey(),
    models: MODELS,
    hint: hasKey() ? undefined : "Set GEMINI_API_KEY in your Vercel project settings.",
  });
}
