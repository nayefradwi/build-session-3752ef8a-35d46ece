"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import {
  Eye,
  Globe2,
  KanbanSquare,
  Loader2,
  Lock,
  RefreshCw,
  Users,
} from "lucide-react";

import { ApiError, apiClient } from "@/lib/client/api-client";
import { cn } from "@/lib/client/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/* -------------------------------------------------------------------------- */
/*                                API contract                                */
/* -------------------------------------------------------------------------- */

/** Mirrors the visibility column on `projects` in the database. */
type ProjectVisibility = "public" | "private";

/**
 * Single row from `GET /api/tenant/projects`. The endpoint pre-filters by
 * the caller's identity:
 *   - Public projects appear for every tenant member.
 *   - Private projects only appear when the caller has a `team_memberships`
 *     row for the owning team.
 *
 * `isMember` reflects whether the caller belongs to the owning team — the
 * board page reuses the same flag (via the project-detail endpoint) to gate
 * write affordances, so visitors of a public project from a team they
 * don't belong to land on a read-only board.
 */
type DirectoryProject = {
  teamId: string;
  teamName: string;
  projectId: string;
  projectName: string;
  visibility: ProjectVisibility;
  isMember: boolean;
};

type DirectoryResponse = { projects: DirectoryProject[] };

/* -------------------------------------------------------------------------- */
/*                             Top-level component                            */
/* -------------------------------------------------------------------------- */

/**
 * Tenant-wide project directory.
 *
 *   - Loads every visible project once the session is settled (we wait for
 *     `useSession` to resolve so we don't fire a request that would just
 *     401 during the brief NextAuth bootstrap window).
 *   - Renders a 1/2/3-column responsive grid of project cards. Each card is
 *     wrapped in a `Link` to `/teams/[teamId]/board`, which is the canonical
 *     route for "open the team's board". The board page already drives its
 *     read-only mode off the project endpoint's `isMember` flag, so a
 *     visitor on a public project lands on a board with no
 *     create/edit/delete affordances and no drag handles.
 *   - Surfaces a small chip set on each card: visibility (public vs.
 *     private) and a "Member" pill when the caller belongs to the owning
 *     team. The visibility chip is the project-level scope (matches the
 *     server's `visibility` column), distinct from the membership chip
 *     which is per-user.
 *   - A header-level filter lets the caller toggle between "All projects"
 *     and "Member only" without a refetch — the API already returns the
 *     full set of projects the user can see (public + the private projects
 *     they belong to), so the filter is purely a client-side slice.
 */
export function ProjectsDirectory() {
  const { status: sessionStatus } = useSession();

  const [projects, setProjects] = useState<DirectoryProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "member">("all");

  const loadProjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiClient.get<DirectoryResponse>(
        "/api/tenant/projects",
        { silent: true },
      );
      setProjects(data.projects ?? []);
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : "Unable to load projects.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (sessionStatus === "loading") return;
    if (sessionStatus === "unauthenticated") return;
    void loadProjects();
  }, [loadProjects, sessionStatus]);

  // Slice to apply the client-side filter. Memoized so the card grid keeps
  // referential stability when only unrelated state changes (e.g. the
  // refresh button's loading flag flips).
  const visibleProjects = useMemo(() => {
    if (filter === "member") return projects.filter((p) => p.isMember);
    return projects;
  }, [filter, projects]);

  const memberCount = useMemo(
    () => projects.filter((p) => p.isMember).length,
    [projects],
  );

  const sessionLoading = sessionStatus === "loading";
  const showMeta = !sessionLoading && !error && projects.length > 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {showMeta
            ? `${projects.length} ${projects.length === 1 ? "project" : "projects"} visible · ${memberCount} on your teams.`
            : "Projects from public teams + every team you belong to."}
        </p>
        <div className="flex items-center gap-2">
          <FilterToggle filter={filter} onChange={setFilter} />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void loadProjects()}
            disabled={loading}
            aria-label="Refresh projects"
          >
            <RefreshCw
              className={cn("h-4 w-4", loading && "animate-spin")}
              aria-hidden="true"
            />
            <span>Refresh</span>
          </Button>
        </div>
      </div>

      <ProjectsList
        projects={visibleProjects}
        totalCount={projects.length}
        filter={filter}
        loading={loading}
        sessionLoading={sessionLoading}
        error={error}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Filter toggle                                 */
/* -------------------------------------------------------------------------- */

type FilterToggleProps = {
  filter: "all" | "member";
  onChange: (next: "all" | "member") => void;
};

/**
 * Two-state segmented control for the All / Member filter. We render this
 * as a `role="tablist"` with two `<button>`s so keyboard nav (Tab to focus,
 * Space/Enter to activate) works without a custom listener.
 */
function FilterToggle({ filter, onChange }: FilterToggleProps) {
  return (
    <div
      role="tablist"
      aria-label="Filter projects"
      className="inline-flex h-9 items-center rounded-md border bg-muted p-0.5 text-xs font-medium"
    >
      <FilterTab
        active={filter === "all"}
        onClick={() => onChange("all")}
        label="All"
      />
      <FilterTab
        active={filter === "member"}
        onClick={() => onChange("member")}
        label="My teams"
      />
    </div>
  );
}

function FilterTab({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 items-center justify-center rounded-sm px-3 transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Projects list                                 */
/* -------------------------------------------------------------------------- */

type ProjectsListProps = {
  projects: DirectoryProject[];
  totalCount: number;
  filter: "all" | "member";
  loading: boolean;
  sessionLoading: boolean;
  error: string | null;
};

function ProjectsList({
  projects,
  totalCount,
  filter,
  loading,
  sessionLoading,
  error,
}: ProjectsListProps) {
  if (sessionLoading || (loading && totalCount === 0)) {
    return (
      <div
        className="flex items-center gap-3 rounded-lg border bg-background px-6 py-10 text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        <span>Loading projects…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
      >
        {error}
      </div>
    );
  }

  // Distinguish "no projects at all" (the tenant has nothing visible to
  // this user) from "the active filter happens to hide everything"
  // (totalCount > 0 but the slice is empty). Each gets its own copy so the
  // user understands why the grid is empty.
  if (projects.length === 0) {
    if (totalCount === 0) {
      return <ProjectsEmptyState />;
    }
    return <ProjectsFilterEmptyState filter={filter} />;
  }

  return (
    <ul
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
      role="list"
    >
      {projects.map((project) => (
        <li
          key={project.projectId}
          className="h-full"
        >
          <ProjectCard project={project} />
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/*                                Project card                                */
/* -------------------------------------------------------------------------- */

type ProjectCardProps = {
  project: DirectoryProject;
};

/**
 * Single project tile. The whole card is a link to the team's board page
 * (`/teams/[teamId]/board`); the board reads `isMember` from its own
 * project-detail fetch and falls into a read-only mode when the caller
 * isn't a member of the owning team — exactly what we want for visitors
 * on a public project.
 */
function ProjectCard({ project }: ProjectCardProps) {
  const ariaLabel = useMemo(() => {
    const visibilityLabel =
      project.visibility === "public" ? "public" : "private";
    const membershipLabel = project.isMember
      ? "you are a team member"
      : "you are not a member";
    return `Open ${project.projectName} on team ${project.teamName} (${visibilityLabel}, ${membershipLabel})`;
  }, [project]);

  return (
    <Link
      href={`/teams/${project.teamId}/board`}
      aria-label={ariaLabel}
      className="group block h-full rounded-lg outline-none ring-offset-2 ring-offset-background transition-shadow focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Card className="flex h-full flex-col gap-3 p-5 transition-colors group-hover:border-foreground/30 group-hover:shadow-md">
        <div className="flex items-start justify-between gap-3">
          <CardHeader className="space-y-1.5 p-0">
            <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Users className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="truncate">{project.teamName}</span>
            </p>
            <CardTitle className="flex items-start gap-2 text-lg leading-snug">
              <KanbanSquare
                className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="line-clamp-2 break-words">
                {project.projectName}
              </span>
            </CardTitle>
          </CardHeader>
          <VisibilityBadge visibility={project.visibility} />
        </div>

        <CardDescription className="flex flex-wrap items-center gap-2 text-xs">
          {project.isMember ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-700 dark:text-emerald-400">
              <Users className="h-3 w-3" aria-hidden="true" />
              Member
            </span>
          ) : project.visibility === "public" ? (
            <span className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 font-medium text-muted-foreground">
              <Eye className="h-3 w-3" aria-hidden="true" />
              Read-only
            </span>
          ) : null}
        </CardDescription>
      </Card>
    </Link>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Visibility badge                              */
/* -------------------------------------------------------------------------- */

function VisibilityBadge({ visibility }: { visibility: ProjectVisibility }) {
  // Visibility is the project-level scope (matches the `projects.visibility`
  // column). We render it as a small bordered chip so it doesn't compete
  // with the project name for visual weight, but is still scannable at the
  // top-right of every card.
  if (visibility === "public") {
    return (
      <span
        aria-label="Public project — visible to everyone in your tenant"
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:text-sky-400"
      >
        <Globe2 className="h-3 w-3" aria-hidden="true" />
        Public
      </span>
    );
  }
  return (
    <span
      aria-label="Private project — visible to team members only"
      className="inline-flex shrink-0 items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
    >
      <Lock className="h-3 w-3" aria-hidden="true" />
      Private
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Empty states                                  */
/* -------------------------------------------------------------------------- */

function ProjectsEmptyState() {
  return (
    <Card className="border-dashed">
      <CardHeader className="items-center text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <KanbanSquare
            className="h-6 w-6 text-muted-foreground"
            aria-hidden="true"
          />
        </div>
        <CardTitle className="text-xl">No projects yet</CardTitle>
        <CardDescription className="max-w-md">
          Your tenant doesn&apos;t have any visible projects. Once a team is
          created — or someone makes a project public — it&apos;ll show up
          here.
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

function ProjectsFilterEmptyState({ filter }: { filter: "all" | "member" }) {
  // Only the "member" filter can produce this state in practice (the "all"
  // path falls through to ProjectsEmptyState whenever totalCount === 0),
  // but we branch defensively in case the filter set grows later.
  return (
    <Card className="border-dashed">
      <CardHeader className="items-center text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Users
            className="h-6 w-6 text-muted-foreground"
            aria-hidden="true"
          />
        </div>
        <CardTitle className="text-xl">
          {filter === "member"
            ? "You're not on any team projects yet"
            : "No projects match this filter"}
        </CardTitle>
        <CardDescription className="max-w-md">
          {filter === "member"
            ? "Switch to All projects to browse public boards across the tenant, or ask a team admin to add you as a member."
            : "Try clearing the filter to see every visible project."}
        </CardDescription>
      </CardHeader>
    </Card>
  );
}
