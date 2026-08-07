import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import {
  drizzle as drizzlePg,
  type NodePgDatabase,
} from "drizzle-orm/node-postgres";
import { env } from "@/lib/env";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

let cached: Db | undefined;

/**
 * Neon's serverless HTTP driver in production (no TCP handshake per
 * invocation), plain node-postgres against local Postgres in dev.
 * Both expose the same Drizzle query API; typed as the node-postgres
 * flavor, which is the one used in dev and tests.
 */
export function db(): Db {
  if (!cached) {
    const url = env().DATABASE_URL;
    cached = url.includes("neon.tech")
      ? (drizzleNeon({ connection: url, schema }) as unknown as Db)
      : drizzlePg({ connection: url, schema });
  }
  return cached;
}

export * as tables from "./schema";
