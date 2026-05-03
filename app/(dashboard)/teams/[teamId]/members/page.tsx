import type { Metadata } from "next";

import { TeamMembersManager } from "@/components/teams/team-members-manager";

export const metadata: Metadata = {
  title: "Team members",
  description:
    "View team members, manage roles, add new members, and remove existing ones.",
};

/**
 * Force per-request rendering: the members list is per-tenant + the admin
 * controls (add / role-change / remove) gate on the live session role and
 * per-team membership, so we don't want any prerender / route cache hits
 * across users.
 */
export const dynamic = "force-dynamic";

/**
 * Team members management page.
 *
 * The dashboard layout (`app/(dashboard)/layout.tsx`) already enforces that a
 * session exists; we delegate the data fetching, the team-admin gating, and
 * all of the dialog wiring to the client `TeamMembersManager` so it can react
 * to `useSession()` and the live API state without an additional server-side
 * round trip per render.
 *
 * In Next.js 15 dynamic-segment params are async — `params` is a Promise and
 * must be awaited before destructuring.
 */
export default async function TeamMembersPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = await params;
  return <TeamMembersManager teamId={teamId} />;
}
