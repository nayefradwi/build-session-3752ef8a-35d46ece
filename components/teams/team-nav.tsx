"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import {
  KanbanSquare,
  Loader2,
  Settings,
  ShieldCheck,
  Users,
} from "lucide-react";

import { ApiError, apiClient } from "@/lib/client/api-client";
import { cn } from "@/lib/client/utils";

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
/*                                Helpers                                     */
/* -------------------------------------------------------------------------- */

type SubLink = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  /**
   * If true, the link is only rendered when the caller is a team admin. The
   * server-side mutations for these routes (e.g. `PUT /api/teams/[teamId]`,
   * `PUT /api/teams/[teamId]/project`) gate on team admin, so this mirrors the
   * gate that already protects the underlying actions — non-admins simply
   * don't see the entry point.
   */
  adminOnly?: boolean;
  /**
   * Predicate that decides whether the current path should mark this link as
   * "active". We keep the predicate explicit so e.g. nested board sub-routes
   * still highlight the Board tab.
   */
  isActive: (pathname: string, base: string) => boolean;
};

const SUB_LINKS: ReadonlyArray<SubLink> = [
  {
    href: "/board",
    label: "Board",
    icon: KanbanSquare,
    isActive: (pathname, base) =>
      pathname === `${base}/board` || pathname.startsWith(`${base}/board/`),
  },
  {
    href: "/members",
    label: "Members",
    icon: Users,
    isActive: (pathname, base) =>
      pathname === `${base}/members` ||
      pathname.startsWith(`${base}/members/`),
  },
  {
    href: "/settings",
    label: "Settings",
    icon: Settings,
    adminOnly: true,
    isActive: (pathname, base) =>
      pathname === `${base}/settings` ||
      pathname.startsWith(`${base}/settings/`),
  },
];

/* -------------------------------------------------------------------------- */
/*                            Top-level component                             */
/* -------------------------------------------------------------------------- */

type TeamNavProps = {
  teamId: string;
};

/**
 * Sub-navigation rendered on every `/teams/[teamId]/**` page via the segment
 * layout. It exposes:
 *
 *   - The team name as a section heading so the active team is always
 *     visible (mirrored in the per-page `<h1>` for screen readers, which is
 *     why this header uses `<h2>`).
 *   - Quick links to Board, Members, and (for team admins) Settings, with the
 *     current sub-route highlighted via `usePathname()`.
 *
 * The component fetches `GET /api/teams/[teamId]` itself so the layout above
 * can stay a thin server component. The endpoint is open to any tenant
 * member, and admin gating for Settings reads off the per-team membership row
 * — tenant-level admins do NOT bypass the per-team role gate, matching the
 * server-side check on the underlying mutations.
 *
 * Errors are intentionally non-fatal: if the fetch fails or the team isn't
 * found, the nav falls back to a minimal "Team" heading + always-visible
 * Board / Members tabs so the user can still navigate around. The wrapped
 * page (`{children}`) renders its own canonical not-found / error UI.
 */
export function TeamNav({ teamId }: TeamNavProps) {
  const pathname = usePathname() ?? "";
  const { data: session, status: sessionStatus } = useSession();
  const callerId = session?.user?.id ?? null;

  const [team, setTeam] = useState<TeamSummary | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const loadTeam = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const data = await apiClient.get<TeamDetailResponse>(
        `/api/teams/${teamId}`,
        { silent: true, skipAuthRedirect: true },
      );
      setTeam(data.team);
      setMembers(data.members ?? []);
    } catch (err) {
      // We swallow errors here on purpose — the wrapped page will surface the
      // canonical error UI. The nav just degrades to a minimal label.
      setFailed(true);
      if (!(err instanceof ApiError)) {
        // Unexpected; log so it shows up in dev consoles.
        console.error("TeamNav: failed to load team", err);
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

  // Caller's per-team membership row, if any. Drives the Settings tab gate
  // (mirrors `team-detail-hub.tsx`'s logic — keep them in sync).
  const callerMembership = useMemo(() => {
    if (!callerId) return null;
    return members.find((m) => m.userId === callerId) ?? null;
  }, [callerId, members]);

  const isTeamAdmin = callerMembership?.role === "admin";

  const base = `/teams/${teamId}`;

  // We render a stable set of links so the layout doesn't reflow when the
  // membership fetch resolves: Settings is hidden until we know the caller is
  // an admin (the fallback during loading errs on the side of "not admin",
  // which matches what the underlying API returns for non-admins anyway).
  const visibleLinks = useMemo(
    () => SUB_LINKS.filter((link) => !link.adminOnly || isTeamAdmin),
    [isTeamAdmin],
  );

  /* -------------------------------- Render -------------------------------- */

  return (
    <nav
      aria-label="Team navigation"
      className="rounded-lg border bg-card text-card-foreground shadow-sm"
    >
      <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-5 sm:py-4">
        <TeamHeading
          team={team}
          loading={loading && !team}
          failed={failed && !team}
          isTeamAdmin={isTeamAdmin}
        />
        <ul className="-mx-1 flex flex-wrap items-center gap-1 sm:flex-nowrap sm:justify-end">
          {visibleLinks.map((link) => {
            const href = `${base}${link.href}`;
            const active = link.isActive(pathname, base);
            const Icon = link.icon;
            return (
              <li key={link.href}>
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    "outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    active
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" aria-hidden={true} />
                  <span>{link.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Heading slot                                  */
/* -------------------------------------------------------------------------- */

type TeamHeadingProps = {
  team: TeamSummary | null;
  loading: boolean;
  failed: boolean;
  isTeamAdmin: boolean;
};

function TeamHeading({ team, loading, failed, isTeamAdmin }: TeamHeadingProps) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span
        aria-hidden={true}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"
      >
        <Users className="h-4 w-4" />
      </span>
      <div className="min-w-0 space-y-0.5">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Team
        </p>
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-base font-semibold tracking-tight">
            {team?.name ?? (loading ? "" : failed ? "Team" : "Team")}
          </h2>
          {loading && !team ? (
            <Loader2
              className="h-3.5 w-3.5 animate-spin text-muted-foreground"
              aria-label="Loading team"
            />
          ) : null}
          {team && isTeamAdmin ? (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400"
              title="You're a team admin"
            >
              <ShieldCheck className="h-3 w-3" aria-hidden={true} />
              Admin
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
