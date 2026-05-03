import "server-only";

import NextAuth from "next-auth";

import { authConfig } from "@/lib/server/auth/config";

// Side-effect import: pulls in the module augmentation that adds tenantId /
// role to the User and JWT types.
import "@/lib/server/auth/types";

/**
 * Single source of truth for NextAuth.js v5. The Route Handler at
 * `app/api/auth/[...nextauth]/route.ts` re-exports `handlers`; server
 * components, route handlers, and middleware can import `auth`, `signIn`,
 * `signOut` from here.
 */
export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
