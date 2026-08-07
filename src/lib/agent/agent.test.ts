/**
 * One mocked pass through the real tool loop.
 *
 * The point is not to test Claude — it's to prove the wiring: a canned model
 * response naming `search_inquiries` with specific args must actually reach our
 * Drizzle query and come back with the row shape the prompt promises. Runs
 * against the seeded local Postgres (DATABASE_URL); the model is mocked, so no
 * Anthropic key and no network are needed.
 *
 * Plus two cheap regression locks on the frozen system prompt.
 */
import { simulateReadableStream, stepCountIs, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeAll, describe, expect, it } from "vitest";
import { REFERENCE_DATE } from "@/lib/config";
import { SYSTEM_PROMPT } from "./system-prompt";
import { freightTools } from "./tools";

beforeAll(() => {
  try {
    process.loadEnvFile(".env");
  } catch {
    // CI supplies env directly.
  }
});

const USAGE = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

const TOOL_ARGS = {
  equipment: "Refrigerated",
  availability: "available",
  limit: 5,
} as const;

describe("agent tool loop", () => {
  it("executes search_inquiries with the model's args and returns rows", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        // Step 1: the model asks for a tool call.
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "search_inquiries",
                // Provider layer hands the SDK a JSON *string*.
                input: JSON.stringify(TOOL_ARGS),
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool_use" },
                usage: USAGE,
              },
            ],
          }),
        },
        // Step 2: the model answers from the tool result.
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t1" },
              { type: "text-delta", id: "t1", delta: "Answer." },
              { type: "text-end", id: "t1" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "end_turn" },
                usage: USAGE,
              },
            ],
          }),
        },
      ],
    });

    const result = streamText({
      model,
      instructions: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: "Who has reefer capacity available?" },
      ],
      tools: freightTools,
      stopWhen: stepCountIs(6),
    });

    await result.consumeStream();

    const toolCalls = await result.toolCalls;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.toolName).toBe("search_inquiries");
    expect(toolCalls[0]?.input).toEqual(TOOL_ARGS);

    const toolResults = await result.toolResults;
    expect(toolResults).toHaveLength(1);

    const output = toolResults[0]?.output as {
      total_matches: number;
      returned: number;
      results: Array<{
        extracted_equipment: string | null;
        extracted_load_reference: string | null;
      }>;
    };

    expect(output.total_matches).toBeGreaterThan(0);
    expect(output.results.length).toBeLessThanOrEqual(TOOL_ARGS.limit);
    expect(output.returned).toBe(output.results.length);

    const first = output.results[0];
    expect(first).toBeDefined();
    // The citable id and the fields the prompt promises must be present.
    expect(first).toHaveProperty("id");
    expect(first).toHaveProperty("source_type");
    expect(first).toHaveProperty("snippet");
    expect(first).toHaveProperty("extracted_availability", "available");
    expect(first).toHaveProperty("extracted_equipment");
    expect(first).toHaveProperty("discrepancy_flags");
    expect(first).toHaveProperty("mc_low_confidence");
    // `equipment` means the freight being discussed, so a row may match on its
    // own tag OR through the load it references — asserting the tag on every
    // row would re-encode the equipment-blind bug this filter was fixed for.
    // Semantics are pinned properly in `tools.test.ts`; this test owns wiring.
    expect(
      first?.extracted_equipment === "Refrigerated" ||
        first?.extracted_load_reference != null,
    ).toBe(true);
    // Dataset decoys must never reach the model.
    expect(first).not.toHaveProperty("stated_intent");
    expect(first).not.toHaveProperty("stated_equipment");

    expect(await result.text).toBe("Answer.");
  });

  it("exposes every tool under a stable registry key", () => {
    expect(Object.keys(freightTools).sort()).toEqual([
      "carrier_history",
      "get_load",
      "market_rate",
      "search_inquiries",
    ]);
  });
});

describe("system prompt", () => {
  it("pins the snapshot date", () => {
    expect(REFERENCE_DATE).toBe("2026-05-25");
    expect(SYSTEM_PROMPT).toContain(REFERENCE_DATE);
    expect(SYSTEM_PROMPT).toMatch(/Today is 2026-05-25/);
  });

  it("instructs bracketed source citations", () => {
    expect(SYSTEM_PROMPT).toMatch(/cite the source id in square brackets/i);
    expect(SYSTEM_PROMPT).toContain("[CE0074]");
  });

  it("keeps the compliance gate and the abstention rule", () => {
    expect(SYSTEM_PROMPT).toMatch(/carrier_history/);
    expect(SYSTEM_PROMPT).toMatch(/authority_status/);
    expect(SYSTEM_PROMPT).toMatch(/insurance_expiry/);
    expect(SYSTEM_PROMPT).toMatch(/never guess/i);
  });

  it("mentions no date other than the snapshot date", () => {
    const dates = SYSTEM_PROMPT.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
    expect(dates.length).toBeGreaterThan(0);
    expect(new Set(dates)).toEqual(new Set([REFERENCE_DATE]));
  });
});
