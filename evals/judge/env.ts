/**
 * CLI-only env bootstrap so `pnpm exec tsx evals/judge/calibrate.ts` works
 * without a `--env-file` flag. Next.js loads `.env` itself at request time; a
 * bare tsx process does not. Never imported by `judge.ts` — the harness that
 * calls the judge owns its own env loading.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function ensureEnv(): void {
  if (process.env.ANTHROPIC_API_KEY) return;
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const envPath = join(repoRoot, ".env");
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set (looked in process env and .env)",
    );
  }
}
