import { anthropic } from "@ai-sdk/anthropic";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  toUIMessageStream,
} from "ai";
import { sanitizeMessages } from "@/lib/agent/sanitize";
import { SYSTEM_PROMPT } from "@/lib/agent/system-prompt";
import { freightTools } from "@/lib/agent/tools";
import type { FreightUIMessage } from "@/lib/agent/ui";
import { countRows, logToolCall } from "@/lib/log";

/** Six steps is enough for search -> carrier_history -> load lookup -> answer. */
const MAX_STEPS = 6;

/**
 * Per-step output cap. Without it the AI SDK defaults to the model's ceiling
 * (128000 on claude-opus-5), leaving a runaway generation unbounded. Kept in
 * lockstep with `MAX_OUTPUT_TOKENS` in `evals/lib/run-agent.ts` — that file
 * mirrors this route field for field, and a divergence means the eval stops
 * measuring the shipped agent.
 */
const MAX_OUTPUT_TOKENS = 8192;

/** Tool loops with a reasoning model can run long; Vercel's default is 10s. */
export const maxDuration = 60;

export async function POST(req: Request) {
  const { messages }: { messages: FreightUIMessage[] } = await req.json();
  // The cast above is erased at runtime — the client controls this payload.
  // sanitizeMessages() is the actual trust boundary: roles + text only, so a
  // forged tool result can never reach the model as grounded fact.
  const history = sanitizeMessages(messages);

  const result = streamText({
    model: anthropic("claude-opus-5"),
    // `instructions` is the v7 name for what used to be `system`.
    instructions: SYSTEM_PROMPT,
    messages: await convertToModelMessages(history, { tools: freightTools }),
    tools: freightTools,
    stopWhen: stepCountIs(MAX_STEPS),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    // No temperature / top_p / top_k: claude-opus-5 rejects them, and extended
    // thinking (on by default) is what makes tool selection good here.
    onToolExecutionEnd({ toolCall, toolOutput, toolExecutionMs }) {
      logToolCall({
        tool: toolCall.toolName,
        args: toolCall.input,
        rows:
          toolOutput.type === "tool-result" ? countRows(toolOutput.output) : -1,
        ms: toolExecutionMs,
      });
    },
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      onError: (error) => {
        console.error(
          JSON.stringify({
            event: "chat_error",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        return "Something went wrong answering that. Please try again.";
      },
    }),
  });
}
