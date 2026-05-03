import { handlers } from "@/lib/server/auth";

// NextAuth.js v5 exposes a single { GET, POST } handler pair from the
// initialized auth() instance. Re-export both verbs from this catch-all so
// `/api/auth/*` (callback, csrf, session, signin, signout, providers, …)
// routes through the configured Credentials provider.
export const { GET, POST } = handlers;

// Force the Node.js runtime: bcrypt (used by the Credentials authorize
// callback) is a native module and is not available in the Edge runtime.
export const runtime = "nodejs";

// The auth endpoints write to the session cookie / read from the database;
// they must never be statically rendered or cached.
export const dynamic = "force-dynamic";
