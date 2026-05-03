import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { auth } from "@/lib/server/auth";
import { DashboardNav } from "@/components/dashboard/dashboard-nav";

/**
 * Dashboard shell.
 *
 * The Edge middleware at `/middleware.ts` already redirects unauthenticated
 * requests on protected segments to `/login` based on session-cookie
 * presence. That's a coarse gate — we still call `auth()` here to get the
 * authoritative, validated session and surface the user's name/email in
 * the top navigation. If the cookie was present but the JWT is invalid /
 * expired we fall through to the same `/login?next=…` redirect as the
 * middleware so the user lands in a recoverable state.
 */
export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await auth();
  if (!session?.user) {
    redirect("/login?next=/dashboard");
  }

  const { name, email, image } = session.user;
  const navUser = {
    name: name ?? null,
    email: email ?? null,
    image: image ?? null,
  };

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <DashboardNav user={navUser} />
      <main className="flex-1">
        <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
          {children}
        </div>
      </main>
    </div>
  );
}
