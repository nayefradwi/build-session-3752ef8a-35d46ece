import type { Metadata } from "next";

import { ProjectsDirectory } from "@/components/projects/projects-directory";

export const metadata: Metadata = {
  title: "Projects",
  description:
    "Discover every project visible to you across your tenant — public boards from any team and private boards on the teams you belong to.",
};

/**
 * Force per-request rendering: the directory is per-tenant + per-user (the
 * `isMember` flag from `GET /api/tenant/projects` depends on the caller's
 * team memberships), so we don't want any prerender / route-level cache
 * hits across users.
 */
export const dynamic = "force-dynamic";

/**
 * Projects discovery page.
 *
 * The dashboard layout (`app/(dashboard)/layout.tsx`) already enforces that
 * an authenticated session exists; we delegate the data fetching to a
 * client `ProjectsDirectory` so it can drive its own loading skeleton,
 * error retry, and refresh affordance without a full server round-trip on
 * every interaction.
 */
export default function ProjectsPage() {
  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Workspace
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Projects</h1>
        <p className="max-w-2xl text-muted-foreground">
          Browse every project visible to you across your tenant. Public
          boards are open to read for everyone; private boards only appear
          on teams you belong to.
        </p>
      </header>

      <ProjectsDirectory />
    </div>
  );
}
