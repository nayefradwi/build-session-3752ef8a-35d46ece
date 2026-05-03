import type { Metadata } from "next";

import { TeamDetailHub } from "@/components/teams/team-detail-hub";

export const metadata: Metadata = {
  title: "Team",
  description:
    "Team hub with quick links to the board, members, and team settings.",
};

/**
 * Force per-request rendering: the team hub mirrors per-tenant data and the
 * Settings link is admin-only (gated client-side from the membership list
 * returned by `GET /api/teams/[teamId]`). Prerender / route caching across
 * users would let the wrong viewer see the admin-gated affordance.
 */
export const dynamic = "force-dynamic";

/**
 * Team detail page (`/teams/[teamId]`).
 *
 * Auth is enforced one segment up by the dashboard layout
 * (`app/(dashboard)/layout.tsx`); we delegate the data fetch + admin gating
 * to the client `TeamDetailHub` so it can react to `useSession()` and the
 * live API state without a server-side round trip per render.
 *
 * In Next.js 15 dynamic-segment params are async — `params` is a Promise and
 * must be awaited before destructuring.
 */
export default async function TeamDetailPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = await params;
  return <TeamDetailHub teamId={teamId} />;
}
