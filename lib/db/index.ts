import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

// `prepare: false` keeps things compatible with Neon's pooled connection
// string. A single client is reused across the lambda lifetime; Drizzle's
// query builder wraps it.
const client = postgres(connectionString, { prepare: false });

export const db = drizzle(client, { schema });
export { schema };
