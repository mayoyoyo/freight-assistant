import { z } from "zod";

/**
 * Server env, Zod-validated, fail-fast at first use.
 * Secrets never live in code — see .env.example.
 */
const serverEnvSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

export function env(): ServerEnv {
  if (!cached) {
    cached = serverEnvSchema.parse(process.env);
  }
  return cached;
}
