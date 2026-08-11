/**
 * The agent, invoked in-process.
 *
 * This deliberately mirrors `src/app/api/chat/route.ts` field for field —
 * same model, same `instructions`, same `tools`, same `stopWhen` — with one
 * substitution: `generateText` instead of `streamText`, because the eval wants
 * the finished answer and no UI stream. If the route's config changes, this
 * file must change with it or the eval stops measuring the shipped agent.
 *
 * Nothing here reads the clock for agent-visible state: `REFERENCE_DATE` is
 * the only "now" the agent sees (spec invariant), and the only wall-clock read
 * is the latency measurement, which never reaches the model.
 */
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs } from "ai";
import { SYSTEM_PROMPT } from "@/lib/agent/system-prompt";
import { freightTools } from "@/lib/agent/tools";
import { countRows } from "@/lib/log";
import { figuresInToolResult, idsInToolResult } from "./extract";
import type { ToolCallRecord, Usage } from "./types";

/** Same cap as the route. Six steps covers search -> history -> load -> answer. */
export const MAX_STEPS = 6;

/**
 * Output cap per step, pinned rather than defaulted — and mirrored in
 * `src/app/api/chat/route.ts`, per this file's own rule.
 *
 * With no `maxOutputTokens` the AI SDK falls back to the model's ceiling
 * (128000 on `claude-opus-5`). The measured baseline is 703 output tokens per
 * run at a mean of 2.8 steps, so 8192 per step is roughly 30x headroom on the
 * observed distribution while still bounding a runaway generation inside a
 * six-step tool loop.
 *
 * The cap is per step, not per run: six steps can produce up to 6 x 8192.
 */
export const MAX_OUTPUT_TOKENS = 8192;

export const DEFAULT_MODEL = "claude-opus-5";

/**
 * The shipped agent is Anthropic-only; OpenAI models exist here solely for the
 * cross-provider leg of `evals/compare.ts`. Routing on the id prefix keeps the
 * route-mirroring contract above intact for every claude-* model.
 */
export function resolveModel(model: string) {
  return model.startsWith("gpt-") ? openai(model) : anthropic(model);
}

export type AgentRun = {
  text: string;
  tools: ToolCallRecord[];
  steps: number;
  latency_ms: number;
  usage: Usage;
  error: string | null;
};

const ZERO_USAGE: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  total_tokens: 0,
  reasoning_tokens: 0,
  cached_input_tokens: 0,
};

export async function runAgent(
  query: string,
  opts: { model?: string } = {},
): Promise<AgentRun> {
  const model = opts.model ?? DEFAULT_MODEL;
  const tools: ToolCallRecord[] = [];
  const started = performance.now();

  try {
    const result = await generateText({
      model: resolveModel(model),
      // `instructions` is the v7 name for what used to be `system`. Message
      // form carries the Anthropic cache breakpoint (mirrors the route): the
      // tools+system prefix is billed at 0.1x on every step after the first
      // and across back-to-back runs inside the 5-min TTL — exactly the sweep
      // shape. Ignored by the OpenAI leg (foreign providerOptions are
      // dropped; OpenAI caches automatically anyway).
      instructions: {
        role: "system",
        content: SYSTEM_PROMPT,
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
      prompt: query,
      tools: freightTools,
      stopWhen: stepCountIs(MAX_STEPS),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      // No temperature / top_p / top_k: claude-opus-5 rejects them, and extended
      // thinking (on by default) is what makes tool selection good here. The
      // eval therefore cannot pin sampling — which is exactly why k=3 exists.
      onToolExecutionEnd({ toolCall, toolOutput, toolExecutionMs }) {
        const output =
          toolOutput.type === "tool-result" ? toolOutput.output : undefined;
        tools.push({
          name: toolCall.toolName,
          args: (toolCall.input ?? {}) as Record<string, unknown>,
          rows: output === undefined ? -1 : countRows(output),
          ids: idsInToolResult(output),
          figures: figuresInToolResult(output),
          ms: Math.round(toolExecutionMs),
          result: output ?? null,
        });
      },
    });

    const u = result.totalUsage;
    return {
      text: result.text,
      tools,
      steps: result.steps.length,
      latency_ms: Math.round(performance.now() - started),
      usage: {
        input_tokens: u.inputTokens ?? 0,
        output_tokens: u.outputTokens ?? 0,
        total_tokens: u.totalTokens ?? 0,
        reasoning_tokens: u.outputTokenDetails?.reasoningTokens ?? 0,
        cached_input_tokens: u.inputTokenDetails?.cacheReadTokens ?? 0,
      },
      error: null,
    };
  } catch (error) {
    return {
      text: "",
      tools,
      steps: 0,
      latency_ms: Math.round(performance.now() - started),
      usage: ZERO_USAGE,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
