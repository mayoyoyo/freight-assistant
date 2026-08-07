/**
 * Loads `.env` from the repo root regardless of cwd. Same contract as
 * `scripts/seed.ts`: a missing file is fine, ambient env wins in CI.
 * Import for side effect, before anything that reads `process.env`.
 */
import { join } from "node:path";
import { REPO_ROOT } from "./cases";

try {
  process.loadEnvFile(join(REPO_ROOT, ".env"));
} catch {
  // no .env file — rely on ambient env (CI)
}
