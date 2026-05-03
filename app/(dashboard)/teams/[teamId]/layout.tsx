import type { ReactNode } from "react";

import { TeamNav } from "@/components/teams/team-nav";

/**
 * Team segment layout — wraps every `/teams/[teamId]/**` page (the team hub,
 * board, members, and settings) with a shared sub-navigation strip that
 * surfaces the team name and the in-team links (Board / Members / Settings,
 * with Settings admin-gated client-side from the live membership).
 *
 * The dashboard layout one segment up (`app/(dashboard)/layout.tsx`) already
 * enforces auth via `auth()` + redirect, and the inner pages already drive
 * their own data fetching for the page bodies, so this layout stays a thin
 * server component that just slots in the nav above `{children}`.
 *
 * In Next.js 15 dynamic-segment params are async — `params` is a Promise and
 * must be awaited before destructuring.
 */
export default async function TeamLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = await params;
  return (
    <div className="space-y-6">
      <TeamNav teamId={teamId} />
      <div>{children}</div>
    </div>
  );
}
