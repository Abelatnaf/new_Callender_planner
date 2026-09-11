import type { GeminiMatrixEvent } from "@/lib/schemas";

/**
 * Fill the fields every Gemini event must carry.
 *
 * A fixture should name only the thing it is testing. Location, uniform and
 * the estimated-end flag are required of the model on every row, but a test
 * about the ratchet has no opinion about which building an event is in.
 */
/** What a fixture has to say; everything else mx fills in. */
export type MxInput = Partial<GeminiMatrixEvent> &
  Pick<GeminiMatrixEvent, "title" | "day" | "start" | "end">;

export function mx(e: MxInput): GeminiMatrixEvent {
  return {
    raw: e.title,
    kind: "other",
    availability: "BLOCKED",
    confidence: 0.95,
    pax: "Corps",
    appliesToMe: true,
    location: "",
    uniform: "",
    endEstimated: false,
    ...e,
  };
}
