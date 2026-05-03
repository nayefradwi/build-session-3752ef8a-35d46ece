"use server";

import { signOut } from "@/lib/server/auth";

/**
 * Server action that ends the current session and redirects the caller to
 * `/login`. NextAuth.js v5 clears the session cookie as part of `signOut`,
 * so callers don't need any additional client-side teardown. Wire this up
 * from a `<form action={logoutAction}>` in the dashboard chrome (or any
 * other "Sign out" UI) — because it's a server action, it works without
 * client-side JavaScript.
 *
 * NB: NextAuth v5 renamed v4's `callbackUrl` option to `redirectTo`. The
 * behavior is identical — the user is redirected to `/login` after the
 * session cookie is cleared.
 */
export async function logoutAction(): Promise<void> {
  await signOut({ redirectTo: "/login" });
}
