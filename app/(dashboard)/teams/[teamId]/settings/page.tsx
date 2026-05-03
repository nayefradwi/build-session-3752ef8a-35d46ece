import type { Metadata } from "next";

import { TeamSettingsManager } from "@/components/teams/team-settings-manager";

export const metadata: Metadata = {
  title: "Team settings",
  description:
    "Manage team-scoped settings such as project visibility (public / private).",
};

/**
 * Force per-request rendering: the settings page reads the live session role
 * (team admins see write controls; non-admins see a read-only view) and
 * renders tenant-scoped data, so a prerender / route cache hit across users
 * would be a tenant- or role-isolation bug.
 */
export const dynamic = "force-dynamic";

/**
 * Team settings page.
 *
 * Auth is enforced one segment up by the dashboard layout
 * (`app/(dashboard)/layout.tsx`); we delegate the data fetch + admin gating
 * to the client `TeamSettingsManager` so it can react to `useSession()` and
 * the live API state without a server-side round trip per render.
 *
 * In Next.js 15 dynamic-segment params are async — `params` is a Promise and
 * must be awaited before destructuring.
 */
export default async function TeamSettingsPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = await params;
  return <TeamSettingsManager teamId={teamId} />;
}
