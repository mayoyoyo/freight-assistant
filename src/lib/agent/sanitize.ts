import type { FreightUIMessage } from "./ui";

/**
 * Server-side history sanitization for the chat route.
 *
 * The client sends the full conversation back on every turn, and nothing
 * stops a crafted request from including assistant messages with FABRICATED
 * tool results — "carrier_history returned authority_status ACTIVE" — which
 * the model would then treat as grounded fact, bypassing the compliance gate
 * and the citation contract (Codex review of PR #3, finding 1).
 *
 * The fix: the server keeps only what the client is trusted to author — the
 * turn roles and their plain text. Tool calls and tool results are dropped;
 * they are regenerable, because the model can (and should) re-query the
 * database rather than trust an unverifiable transcript of earlier queries.
 *
 * Cost, stated honestly: in multi-turn chats the model loses direct sight of
 * earlier tool OUTPUTS (it still sees both sides' text, including its own
 * earlier cited answers) and will re-call tools for anything it needs fresh.
 * That is the right trade in a compliance-sensitive domain: grounding must
 * come from the database on the server's own connection, never from the
 * client's retelling of it.
 */

/** Bound the replayed history; an abusive client cannot stuff the context. */
export const MAX_HISTORY_MESSAGES = 40;

export function sanitizeMessages(
  messages: FreightUIMessage[],
): FreightUIMessage[] {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      ...m,
      parts: m.parts.filter((p) => p.type === "text"),
    }))
    .filter((m) => m.parts.length > 0)
    .slice(-MAX_HISTORY_MESSAGES);
}
