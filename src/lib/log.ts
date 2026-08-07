/**
 * One JSON line per tool call on stdout. Deliberately not a logging library:
 * the deliverable is a greppable trace of what the agent actually did
 * (`pnpm dev | grep tool_call`), and Vercel's log drain ingests JSON lines.
 */

/** Process-relative clock so log lines are diffable across runs. */
const PROCESS_START_MS = performance.now();

export type ToolCallLog = {
  tool: string;
  args: unknown;
  /** Rows the tool actually returned (0 for a miss), not rows scanned. */
  rows: number;
  ms: number;
};

export function logToolCall(entry: ToolCallLog): void {
  console.log(
    JSON.stringify({
      event: "tool_call",
      ts_ms_relative: Math.round(performance.now() - PROCESS_START_MS),
      tool: entry.tool,
      args: entry.args,
      rows: entry.rows,
      ms: Math.round(entry.ms),
    }),
  );
}

/**
 * Best-effort row count for a tool result. Tools return compact JSON with no
 * single shared shape, so this reads the conventions our tools do use:
 * an array, a `{ rows: [...] }` / `{ inquiries: [...] }` envelope, an explicit
 * `count`, or a single object (1 row) / miss sentinel (0 rows).
 */
export function countRows(output: unknown): number {
  if (output == null) return 0;
  if (Array.isArray(output)) return output.length;
  if (typeof output !== "object") return 1;

  const o = output as Record<string, unknown>;
  if (o.not_found === true || o.no_data === true) return 0;
  for (const key of ["results", "rows", "inquiries", "weeks"]) {
    const v = o[key];
    if (Array.isArray(v)) return v.length;
  }
  return 1;
}
