import { defineConfig } from "drizzle-kit";

try {
  process.loadEnvFile(".env");
} catch {
  // no .env file — rely on ambient env
}

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "DATABASE_URL is required (set it in .env or the environment)",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url },
});
