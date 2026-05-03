import type { Metadata } from "next";

import { KanbanBoard } from "@/components/board/kanban-board";

export const metadata: Metadata = {
  title: "Board",
  description:
    "Kanban board for the team's project — view columns and tasks at a glance.",
};

/**
 * Force per-request rendering: the board page is per-tenant + per-user
 * (`isMember` gates write affordances) and we don't want any prerender /
 * route cache hits across users.
 */
export const dynamic = "force-dynamic";

/**
 * Team kanban board page.
 *
 * Auth is already enforced one segment up by the dashboard layout
 * (`app/(dashboard)/layout.tsx`); we delegate the data fetch + render to a
 * client component so it can drive the loading skeleton, error retry, and
 * any future drag/drop reorders without a full server round-trip.
 *
 * In Next.js 15 dynamic-segment params are async — `params` is a Promise and
 * must be awaited before destructuring.
 */
export default async function TeamBoardPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = await params;
  return <KanbanBoard teamId={teamId} />;
}
