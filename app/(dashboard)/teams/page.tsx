import type { Metadata } from "next";

import { TeamsManager } from "@/components/teams/teams-manager";

export const metadata: Metadata = {
  title: "Teams",
  description:
    "Browse every team in your workspace and create new ones if you're a tenant admin.",
};

/**
 * Force per-request rendering: the teams list is per-tenant + the
 * `Create team` button gating depends on the live session role, so we don't
 * want any prerender / route-level cache hits across users.
 */
export const dynamic = "force-dynamic";

/**
 * Teams directory page.
 *
 * The dashboard layout (`app/(dashboard)/layout.tsx`) already enforces an
 * authenticated session; we delegate the role gate (admin-only "Create team"
 * button) and all data fetching to the client `TeamsManager` so it can react
 * to the `useSession()` cache.
 */
export default function TeamsPage() {
  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Workspace
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Teams</h1>
        <p className="max-w-2xl text-muted-foreground">
          Teams group related work and own a private project board. Admins can
          create new teams and invite members from the Settings panel.
        </p>
      </header>

      <TeamsManager />
    </div>
  );
}
