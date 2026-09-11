import { describe, expect, it } from "vitest";
import { toGeminiSchema } from "@/lib/gemini";
import {
  GeminiMatrixResponseSchema, GeminiPlanResponseSchema, GeminiTermResponseSchema,
} from "@/lib/schemas";

function walk(node: unknown, visit: (o: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) { node.forEach((n) => walk(n, visit)); return; }
  if (!node || typeof node !== "object") return;
  visit(node as Record<string, unknown>);
  Object.values(node as Record<string, unknown>).forEach((v) => walk(v, visit));
}

const SCHEMAS = {
  matrix: GeminiMatrixResponseSchema,
  term: GeminiTermResponseSchema,
  plan: GeminiPlanResponseSchema,
};

describe("toGeminiSchema", () => {
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    describe(name, () => {
      const out = toGeminiSchema(schema);

      it("emits nothing Gemini rejects", () => {
        walk(out, (o) => {
          expect(o).not.toHaveProperty("$ref");
          expect(o).not.toHaveProperty("$defs");
          expect(o).not.toHaveProperty("$schema");
          expect(o).not.toHaveProperty("additionalProperties");
        });
      });

      it("is a serializable object schema", () => {
        expect(out.type).toBe("object");
        expect(() => JSON.stringify(out)).not.toThrow();
      });

      it("keeps the descriptions that steer the model", () => {
        expect(JSON.stringify(out)).toContain("description");
      });
    });
  }

  it("inlines a reused sub-schema rather than referencing it", () => {
    const out = toGeminiSchema(GeminiMatrixResponseSchema);
    const events = (out.properties as Record<string, Record<string, unknown>>).events;
    const item = events.items as Record<string, unknown>;
    expect(item.type).toBe("object");
    expect(Object.keys(item.properties as object)).toContain("availability");
  });

  it("treats defaulted fields as optional so the model may omit them", () => {
    const out = toGeminiSchema(GeminiPlanResponseSchema);
    expect(out.required as string[]).not.toContain("unplaced");
  });

  it("preserves enums so the model cannot invent an availability", () => {
    const json = JSON.stringify(toGeminiSchema(GeminiMatrixResponseSchema));
    expect(json).toContain("BLOCKED");
    expect(json).toContain("USABLE");
    expect(json).toContain("PARTIAL");
  });
});
