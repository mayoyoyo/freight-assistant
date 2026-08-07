import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    // biome-ignore lint/style/noNonNullAssertion: drizzle-kit runs outside the app; fails loudly if unset
    url: process.env.DATABASE_URL!,
  },
});
