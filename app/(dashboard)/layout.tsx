import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { DashboardNav } from "@/components/dashboard/dashboard-nav";

/**
 * NextAuth v5 stores its session token under one of these cookie names —
 * the `__Secure-` prefix is used whenever the cookie is set with `secure`
 * (i.e. on HTTPS deployments). Older deployments may still emit the legacy
 * `next-auth.session-token` name, so we accept those too. We only check for
 * presence here as a fast unauthenticated short-circuit; the authoritative
 * session validation happens server-side in API routes / server actions.
 */
const SESSION_COOKIE_NAMES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
] as const;

type SessionUser = {
  name: string | null;
  email: string | null;
  image?: string | null;
};

/**
 * Best-effort session lookup for the dashboard shell.
 *
 * Returns the authenticated user's display fields when a session cookie is
 * present, or null when it isn't. We deliberately avoid importing a backend
 * auth helper here so this layout stays compilable independent of the
 * NextAuth wiring (which lives in backend territory). Once the canonical
 * `auth()` helper exists this can be replaced with `await auth()`.
 */
async function getSessionUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  for (const name of SESSION_COOKIE_NAMES) {
    if (cookieStore.get(name)?.value) {
      // We don't have a verified user record without contacting the auth
      // backend, so we render the shell with anonymous placeholder fields.
      // Pages inside the shell remain responsible for fetching their own
      // user data via authenticated API calls.
      return { name: null, email: null, image: null };
    }
  }
  return null;
}

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const user = await getSessionUser();
  if (!user) {
    redirect("/login?next=/dashboard");
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <DashboardNav user={user} />
      <main className="flex-1">
        <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
          {children}
        </div>
      </main>
    </div>
  );
}
