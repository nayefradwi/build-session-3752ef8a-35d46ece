"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import {
  AlertCircle,
  ArrowLeft,
  ChevronRight,
  KanbanSquare,
  Loader2,
  Settings,
  ShieldCheck,
  Users,
} from "lucide-react";

import { ApiError, apiClient } from "@/lib/client/api-client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/* -------------------------------------------------------------------------- */
/*                                API contracts                               */
/* -------------------------------------------------------------------------- */

type TeamRole = "admin" | "member";

/** Mirrors the response shape of `GET /api/teams/[teamId]`. */
type TeamMember = {
  userId: string;
  role: TeamRole;
  joinedAt: string;
  email: string;
  name: string | null;
  image: string | null;
};

type TeamSummary = {
  id: string;
  name: string;
  tenantId: string;
  createdAt: string;
};

type TeamDetailResponse = {
  team: TeamSummary;
  members: TeamMember[];
};

/* -------------------------------------------------------------------------- */
/*                            Top-level component                             */
/* -------------------------------------------------------------------------- */

type TeamDetailHubProps = {
  teamId: string;
};

/**
 * Team hub: the landing page for a single team.
 *
 *   - Loads `GET /api/teams/[teamId]` for the team metadata + member roster.
 *     The endpoint is open to any tenant member (so non-members can still see
 *     the team page and decide whether to ask to join), and the admin-only
 *     Settings link is gated client-side based on the caller's per-team role.
 *   - Renders quick-link cards into the team's three sub-routes:
 *       /teams/[teamId]/board        — kanban
 *       /teams/[teamId]/members      — member roster + admin controls
 *       /teams/[teamId]/settings     — admin-only; we hide the link for
 *                                      non-admins to mirror the server-side
 *                                      gate on `PUT /api/teams/[teamId]` /
 *                                      `PUT /api/teams/[teamId]/project`.
 *   - Surfaces a tenant-admin badge for callers whose per-team role is
 *     `"admin"` so the hub doubles as a quick "what can I do here" cue.
 *   - Includes a Teams › <name> breadcrumb so back-navigation is one tap.
 *
 * Errors / not-found / loading are all handled inline so the hub matches the
 * other team-scoped pages' UX.
 */
export function TeamDetailHub({ teamId }: TeamDetailHubProps) {
  const { data: session, status: sessionStatus } = useSession();
  const callerId = session?.user?.id ?? null;

  const [team, setTeam] = useState<TeamSummary | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const loadTeam = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const data = await apiClient.get<TeamDetailResponse>(
        `/api/teams/${teamId}`,
        { silent: true },
      );
      setTeam(data.team);
      setMembers(data.members ?? []);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setNotFound(true);
      } else {
        const message =
          err instanceof ApiError ? err.message : "Unable to load team.";
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    if (sessionStatus === "loading") return;
    if (sessionStatus === "unauthenticated") return;
    void loadTeam();
  }, [loadTeam, sessionStatus]);

  // The caller's per-team membership row, if any. The Settings card mirrors
  // the server-side admin gate on `PUT /api/teams/[teamId]` (team admins only;
  // tenant admins do NOT bypass), so we use the per-team role here rather
  // than `session.user.role`.
  const callerMembership = useMemo(() => {
    if (!callerId) return null;
    return members.find((m) => m.userId === callerId) ?? null;
  }, [callerId, members]);

  const isTeamAdmin = callerMembership?.role === "admin";
  const isMember = callerMembership !== null;
  const memberCount = members.length;

  // Keep the browser tab title in sync with the live team name so a rename
  // shows up immediately without a hard reload. The static `metadata.title`
  // on the page is the SSR fallback.
  useEffect(() => {
    if (!team) return;
    if (typeof document === "undefined") return;
    document.title = `${team.name} · Team`;
  }, [team]);

  /* -------------------------------- Render -------------------------------- */

  if (sessionStatus === "loading" || (loading && !team && !error && !notFound)) {
    return <PageLoadingState />;
  }

  if (notFound) {
    return <PageNotFoundState />;
  }

  if (error && !team) {
    return <PageErrorState message={error} onRetry={() => void loadTeam()} />;
  }

  if (!team) {
    // Defensive — `loading` already gated above; render a spinner just in
    // case the state machine ever falls through here.
    return <PageLoadingState />;
  }

  return (
    <div className="space-y-8">
      <Breadcrumbs teamName={team.name} />

      <header className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <p className="flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">
              <Users className="h-3.5 w-3.5" aria-hidden="true" />
              Team
            </p>
            <h1 className="text-3xl font-semibold tracking-tight">
              {team.name}
            </h1>
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">
                {memberCount}
              </span>{" "}
              {memberCount === 1 ? "member" : "members"}
              {isMember ? (
                <>
                  {" "}
                  ·{" "}
                  <span className="font-medium text-foreground">
                    {isTeamAdmin ? "You're an admin" : "You're a member"}
                  </span>
                </>
              ) : (
                <>
                  {" "}
                  ·{" "}
                  <span className="text-muted-foreground">
                    You&apos;re not on this team
                  </span>
                </>
              )}
            </p>
          </div>
          {isTeamAdmin ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
              Team admin
            </span>
          ) : null}
        </div>
      </header>

      <section
        aria-labelledby="team-hub-quick-links"
        className="space-y-4"
      >
        <h2
          id="team-hub-quick-links"
          className="text-sm font-medium uppercase tracking-wide text-muted-foreground"
        >
          Quick links
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <HubLinkCard
            href={`/teams/${teamId}/board`}
            icon={
              <KanbanSquare
                className="h-5 w-5 text-muted-foreground"
                aria-hidden="true"
              />
            }
            title="Board"
            description="Kanban view of the team's columns and tasks."
          />
          <HubLinkCard
            href={`/teams/${teamId}/members`}
            icon={
              <Users
                className="h-5 w-5 text-muted-foreground"
                aria-hidden="true"
              />
            }
            title="Members"
            description={`${memberCount} ${
              memberCount === 1 ? "person" : "people"
            } on this team.`}
          />
          {isTeamAdmin ? (
            <HubLinkCard
              href={`/teams/${teamId}/settings`}
              icon={
                <Settings
                  className="h-5 w-5 text-muted-foreground"
                  aria-hidden="true"
                />
              }
              title="Settings"
              description="Rename the team and manage project visibility."
              adminOnly
            />
          ) : null}
        </div>
        {!isTeamAdmin ? (
          <p className="text-xs text-muted-foreground">
            Settings are visible to team admins only.
          </p>
        ) : null}
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                Breadcrumbs                                 */
/* -------------------------------------------------------------------------- */

function Breadcrumbs({ teamName }: { teamName: string }) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex items-center text-sm text-muted-foreground"
    >
      <ol className="flex flex-wrap items-center gap-1.5">
        <li>
          <Link
            href="/teams"
            className="rounded-sm font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Teams
          </Link>
        </li>
        <li aria-hidden="true" className="flex items-center">
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </li>
        <li className="min-w-0">
          <span
            className="truncate font-medium text-foreground"
            aria-current="page"
          >
            {teamName}
          </span>
        </li>
      </ol>
    </nav>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Hub link card                                 */
/* -------------------------------------------------------------------------- */

type HubLinkCardProps = {
  href: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  adminOnly?: boolean;
};

function HubLinkCard({
  href,
  icon,
  title,
  description,
  adminOnly,
}: HubLinkCardProps) {
  return (
    <Link
      href={href}
      className="group block rounded-lg outline-none ring-offset-background transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <Card className="h-full transition-colors group-hover:border-foreground/20 group-hover:bg-muted/40">
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              {icon}
              <CardTitle className="text-lg">{title}</CardTitle>
            </div>
            <ChevronRight
              className="mt-1 h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
              aria-hidden="true"
            />
          </div>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        {adminOnly ? (
          <CardContent>
            <span className="inline-flex items-center gap-1.5 rounded-full border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              <ShieldCheck className="h-3 w-3" aria-hidden="true" />
              Admin only
            </span>
          </CardContent>
        ) : null}
      </Card>
    </Link>
  );
}

/* -------------------------------------------------------------------------- */
/*                       Page-level loading / error states                    */
/* -------------------------------------------------------------------------- */

function PageLoadingState() {
  return (
    <div
      className="flex items-center gap-3 rounded-lg border bg-background px-6 py-10 text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      <span>Loading team…</span>
    </div>
  );
}

function PageNotFoundState() {
  return (
    <div className="space-y-4">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/teams">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          All teams
        </Link>
      </Button>
      <div
        role="alert"
        className="rounded-lg border border-dashed bg-background px-6 py-10 text-center"
      >
        <Users
          className="mx-auto h-8 w-8 text-muted-foreground"
          aria-hidden="true"
        />
        <p className="mt-2 text-sm font-medium">Team not found</p>
        <p className="mt-1 text-sm text-muted-foreground">
          This team has been deleted or you don&apos;t have access to it.
        </p>
      </div>
    </div>
  );
}

function PageErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="space-y-4">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/teams">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          All teams
        </Link>
      </Button>
      <div
        role="alert"
        className="flex items-start justify-between gap-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
      >
        <div className="flex items-start gap-2">
          <AlertCircle className="mt-0.5 h-4 w-4" aria-hidden="true" />
          <span>{message}</span>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}
