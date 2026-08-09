/**
 * Prompt loading + parsing for the LLM judge.
 *
 * Kept in its own module (no `ai` / `@ai-sdk/anthropic` imports) so the unit
 * tests can exercise the pure functions with no API key and no network.
 *
 * One markdown file per prompt version holds BOTH checks. Sections are split on
 * a stable `## CHECK: <name>` delimiter; everything above the first delimiter is
 * a file-level comment and is discarded.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type JudgeCheck = "no_invented_commitments" | "professional_tone";

export const CHECKS: readonly JudgeCheck[] = [
  "no_invented_commitments",
  "professional_tone",
];

/**
 * Resolved from the module's own location, not `process.cwd()`, so the judge
 * works when called from the repo root, from `evals/`, or from a test runner.
 */
export const PROMPT_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The design doc's prompt skeleton, in required order. Every check section in
 * every version file must contain all of these headings — asserted in
 * `judge.test.ts` so a malformed prompt fails CI instead of silently degrading
 * a $1 calibration run.
 */
export const REQUIRED_SECTION_HEADINGS = [
  "### Role and domain",
  "### PASS/FAIL criteria",
  "### Named failure types",
  "### What does NOT count as a failure",
  "### Examples",
  "### Output contract",
] as const;

export function promptPath(version: string): string {
  return join(PROMPT_DIR, `prompt-${version}.md`);
}

export function readPromptFile(version: string): string {
  return readFileSync(promptPath(version), "utf8");
}

/** Split a version file into its per-check sections. Pure: takes text, not a path. */
export function parsePromptFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const parts = text.split(/^## CHECK:[ \t]*(\S+)[ \t]*$/m);
  // parts = [preamble, name1, body1, name2, body2, ...]
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i];
    if (!name) continue;
    out[name] = (parts[i + 1] ?? "").trim();
  }
  return out;
}

/** Instructions string for one check of one version. Throws if absent. */
export function loadCheckPrompt(version: string, check: JudgeCheck): string {
  const sections = parsePromptFile(readPromptFile(version));
  const body = sections[check];
  if (!body) {
    throw new Error(
      `prompt-${version}.md has no "## CHECK: ${check}" section (found: ${Object.keys(sections).join(", ") || "none"})`,
    );
  }
  return `## CHECK: ${check}\n\n${body}`;
}

/** The user-turn payload. Kept pure so tests can assert its shape. */
export function buildUserPrompt(
  draftText: string,
  sourceContext: string,
): string {
  return [
    "Evaluate the draft email below against your check.",
    "",
    "<source_context>",
    sourceContext,
    "</source_context>",
    "",
    "<draft_email>",
    draftText,
    "</draft_email>",
    "",
    "Respond with the JSON object described in your output contract: explanation first, then label, then confidence.",
  ].join("\n");
}
