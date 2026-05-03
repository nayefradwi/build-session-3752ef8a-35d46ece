"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSession } from "next-auth/react";
import {
  AlertCircle,
  ArrowLeft,
  Globe2,
  Lock,
  Loader2,
  Settings,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";

import { ApiError, apiClient } from "@/lib/client/api-client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/* -------------------------------------------------------------------------- */
/*                                API contracts                               */
/* -------------------------------------------------------------------------- */

/** Mirrors a row from the project's API surface. */
type ProjectVisibility = "public" | "private";

type Project = {
  id: string;
  teamId: string;
  name: string;
  visibility: ProjectVisibility;
  createdAt: string;
};

/** Shape returned by `GET /api/teams/[teamId]/project`. */
type TeamProjectResponse = {
  project: Project;
  isMember: boolean;
};

/** Shape returned by `GET /api/teams/[teamId]`. */
type TeamMember = {
  userId: string;
  role: "admin" | "member";
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

type TeamSettingsManagerProps = {
  teamId: string;
};

/**
 * Settings surface for a single team.
 *
 *   - Loads the team detail (`GET /api/teams/[teamId]`) so we can determine
 *     whether the caller has `role === "admin"` on this team. The PUT endpoint
 *     enforces team-admin server-side (tenant admins do NOT bypass), so we
 *     mirror that exact gate client-side and only render write affordances if
 *     the caller's per-team role is "admin". Non-admins see a read-only badge.
 *   - Loads the team's project (`GET /api/teams/[teamId]/project`) for the
 *     current visibility value — the API auto-seeds one project per team.
 *   - On change, PUTs to `/api/teams/[teamId]/project` with `{ visibility }`
 *     and shows a sonner toast on success/failure. We reset the local select
 *     value to the server-confirmed state so a failed PUT doesn't leave the
 *     UI in a stale "selected" position.
 *
 * Currently the only setting on this page is project visibility; the surface
 * is laid out as a stack of <Card> sections so additional settings (e.g.
 * project rename, danger zone) can slot in without rework.
 */
export function TeamSettingsManager({ teamId }: TeamSettingsManagerProps) {
  const router = useRouter();
  const { data: session, status: sessionStatus } = useSession();
  const callerId = session?.user?.id ?? null;

  const [team, setTeam] = useState<TeamSummary | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [project, setProject] = useState<Project | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  // Track when we've already kicked off a redirect so a re-render of the
  // gate effect doesn't fire toast.error twice or queue a second navigation.
  const redirectedRef = useRef(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      // Two independent reads — fan out in parallel so the spinner clears in a
      // single round-trip's worth of latency. We tolerate a 403 on the project
      // lookup (private + non-member) so non-admins can still see "team not
      // accessible" without the page exploding.
      const [teamResp, projectResp] = await Promise.all([
        apiClient.get<TeamDetailResponse>(`/api/teams/${teamId}`, {
          silent: true,
        }),
        apiClient
          .get<TeamProjectResponse>(`/api/teams/${teamId}/project`, {
            silent: true,
            skipAuthRedirect: true,
          })
          // Non-admins on a private project hit 403 here; that's not a fatal
          // error for the page (the team detail still renders), so collapse
          // those into a `null` project rather than throwing.
          .catch((err) => {
            if (err instanceof ApiError && err.status === 403) {
              return null;
            }
            throw err;
          }),
      ]);
      setTeam(teamResp.team);
      setMembers(teamResp.members ?? []);
      setProject(projectResp?.project ?? null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setNotFound(true);
      } else {
        const message =
          err instanceof ApiError ? err.message : "Unable to load settings.";
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    if (sessionStatus === "loading") return;
    if (sessionStatus === "unauthenticated") return;
    void loadAll();
  }, [loadAll, sessionStatus]);

  // Caller's per-team membership row. The visibility select is gated on
  // `callerMembership?.role === "admin"`. Tenant-level admins do NOT bypass —
  // mirroring the server-side `PUT /api/teams/[teamId]/project` gate.
  const callerMembership = useMemo(() => {
    if (!callerId) return null;
    return members.find((m) => m.userId === callerId) ?? null;
  }, [callerId, members]);

  const isTeamAdmin = callerMembership?.role === "admin";

  // Admin-only access: this page mirrors the server-side gate on
  // `PUT /api/teams/[teamId]` (team admins only — tenant admins do NOT
  // bypass). We bounce non-admins to the team's members page (which is
  // accessible to any tenant user) with a one-shot toast explaining why.
  // The redirect waits until the team + membership lookups have finished so
  // we don't fire on the first render before `members` is populated.
  useEffect(() => {
    if (sessionStatus !== "authenticated") return;
    if (loading) return;
    if (!team) return;
    if (isTeamAdmin) return;
    if (redirectedRef.current) return;
    redirectedRef.current = true;
    toast.error("Team admins only", {
      description: "Only team admins can access team settings.",
    });
    router.replace(`/teams/${teamId}/members`);
  }, [isTeamAdmin, loading, router, sessionStatus, team, teamId]);

  // Keep the browser tab title in sync with the live team name so a rename
  // is reflected without a hard reload. Static `metadata.title` on the page
  // is the static fallback; this overrides it once the team has loaded.
  useEffect(() => {
    if (!team) return;
    if (typeof document === "undefined") return;
    document.title = `${team.name} · Team settings`;
  }, [team]);

  /**
   * PUT the new team name. Trims, validates non-empty, on success updates
   * the local team state (re-rendering the H1 + browser title), and emits a
   * sonner success toast. Errors are mapped to friendlier messages for the
   * common 403 / 404 / 400 cases.
   */
  const onRenameTeam = useCallback(
    async (rawName: string): Promise<{ ok: boolean; error?: string }> => {
      const name = rawName.trim();
      if (name.length === 0) {
        return { ok: false, error: "Team name can't be empty." };
      }
      if (!team) {
        return { ok: false, error: "Team not loaded yet." };
      }
      if (name === team.name) {
        // No-op — nothing to save.
        return { ok: true };
      }
      try {
        const resp = await apiClient.put<{ team: TeamSummary }>(
          `/api/teams/${teamId}`,
          { name },
          { silent: true, skipAuthRedirect: true },
        );
        setTeam(resp.team);
        toast.success("Team renamed", {
          description: `Team is now called “${resp.team.name}”.`,
        });
        return { ok: true };
      } catch (err) {
        if (err instanceof ApiError) {
          if (err.status === 403) {
            const msg = "Only team admins can rename the team.";
            toast.error("Permission denied", { description: msg });
            return { ok: false, error: msg };
          }
          if (err.status === 404) {
            const msg = "This team no longer exists.";
            toast.error("Team not found", { description: msg });
            return { ok: false, error: msg };
          }
          toast.error("Couldn't rename team", { description: err.message });
          return { ok: false, error: err.message };
        }
        const fallback = "Something went wrong. Please try again.";
        toast.error("Couldn't rename team", { description: fallback });
        return { ok: false, error: fallback };
      }
    },
    [team, teamId],
  );

  const onVisibilityChange = useCallback(
    async (next: ProjectVisibility) => {
      if (!project) return;
      if (project.visibility === next) return;

      // Optimistically reflect the new value so the dropdown closes on the
      // selected option immediately; we'll either confirm with the server
      // response or revert on error.
      const previous = project.visibility;
      setProject({ ...project, visibility: next });

      try {
        const resp = await apiClient.put<{ project: Project }>(
          `/api/teams/${teamId}/project`,
          { visibility: next },
          { silent: true, skipAuthRedirect: true },
        );
        setProject(resp.project);
        toast.success("Project visibility updated", {
          description:
            next === "public"
              ? "Anyone in your workspace can now view this project."
              : "Only team members can view this project now.",
        });
      } catch (err) {
        // Revert the optimistic patch so the UI matches the server.
        setProject((curr) =>
          curr ? { ...curr, visibility: previous } : curr,
        );
        if (err instanceof ApiError && err.status === 403) {
          toast.error("You don't have permission to change visibility", {
            description: "Only team admins can update project visibility.",
          });
        } else if (err instanceof ApiError) {
          toast.error("Couldn't update visibility", {
            description: err.message,
          });
        } else {
          toast.error("Couldn't update visibility", {
            description: "Something went wrong. Please try again.",
          });
        }
      }
    },
    [project, teamId],
  );

  /* -------------------------------- Render -------------------------------- */

  if (
    sessionStatus === "loading" ||
    (loading && !team && !error && !notFound)
  ) {
    return <PageLoadingState />;
  }

  if (notFound) {
    return <PageNotFoundState />;
  }

  if (error && !team) {
    return <PageErrorState message={error} onRetry={() => void loadAll()} />;
  }

  // Non-admins are redirected by the effect above. Render the loading state
  // in the interim so they don't briefly see settings controls flash.
  if (team && !isTeamAdmin) {
    return <PageLoadingState />;
  }

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <Button asChild variant="ghost" size="sm" className="-ml-3">
          <Link href={`/teams/${teamId}/members`}>
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back to team
          </Link>
        </Button>
        <div className="space-y-1">
          <p className="flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">
            <Settings className="h-3.5 w-3.5" aria-hidden="true" />
            Team settings
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">
            {team?.name ?? "Team"}
          </h1>
          <p className="text-sm text-muted-foreground">
            You&apos;re a team admin. Settings changes apply to everyone on
            the team.
          </p>
        </div>
      </header>

      {team ? (
        <TeamNameSection
          key={team.id}
          currentName={team.name}
          onSubmit={onRenameTeam}
        />
      ) : null}

      <ProjectVisibilitySection
        project={project}
        isTeamAdmin={isTeamAdmin}
        onChange={onVisibilityChange}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                            Team name settings card                         */
/* -------------------------------------------------------------------------- */

// Mirror of the server-side `updateTeamInputSchema` bounds in
// `app/api/teams/[teamId]/route.ts` so we surface validation locally rather
// than waiting on a 400 round-trip. Keep these in sync if the server tweaks.
const TEAM_NAME_MAX_LENGTH = 120;

type TeamNameSectionProps = {
  currentName: string;
  onSubmit: (name: string) => Promise<{ ok: boolean; error?: string }>;
};

function TeamNameSection({ currentName, onSubmit }: TeamNameSectionProps) {
  const inputId = useId();
  const errorId = useId();
  const [draft, setDraft] = useState(currentName);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // When the parent confirms a successful rename it passes a new
  // `currentName`; reset the draft so the input reflects the canonical
  // server value (and dirty-state recomputes against the new baseline).
  useEffect(() => {
    setDraft(currentName);
    setValidationError(null);
  }, [currentName]);

  const trimmed = draft.trim();
  const isEmpty = trimmed.length === 0;
  const isDirty = trimmed !== currentName.trim();
  const isTooLong = trimmed.length > TEAM_NAME_MAX_LENGTH;
  const canSubmit = !submitting && isDirty && !isEmpty && !isTooLong;

  const handleSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (isEmpty) {
        setValidationError("Team name can't be empty.");
        return;
      }
      if (isTooLong) {
        setValidationError(
          `Team name must be ${TEAM_NAME_MAX_LENGTH} characters or fewer.`,
        );
        return;
      }
      setValidationError(null);
      setSubmitting(true);
      try {
        const result = await onSubmit(trimmed);
        if (!result.ok && result.error) {
          setValidationError(result.error);
        }
      } finally {
        setSubmitting(false);
      }
    },
    [isEmpty, isTooLong, onSubmit, trimmed],
  );

  const handleReset = useCallback(() => {
    setDraft(currentName);
    setValidationError(null);
  }, [currentName]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Team name</CardTitle>
        <CardDescription>
          The team name appears across the workspace — in the team
          directory, board headers, and member rosters.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor={inputId}>Team name</Label>
            <Input
              id={inputId}
              name="name"
              type="text"
              autoComplete="off"
              maxLength={TEAM_NAME_MAX_LENGTH}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                if (validationError) setValidationError(null);
              }}
              disabled={submitting}
              aria-invalid={validationError ? true : undefined}
              aria-describedby={validationError ? errorId : undefined}
              required
              className="max-w-sm"
            />
            {validationError ? (
              <p
                id={errorId}
                role="alert"
                className="flex items-center gap-1.5 text-xs text-destructive"
              >
                <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
                {validationError}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Up to {TEAM_NAME_MAX_LENGTH} characters.
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? (
                <>
                  <Loader2
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                  Saving…
                </>
              ) : (
                "Save changes"
              )}
            </Button>
            {isDirty && !submitting ? (
              <Button
                type="button"
                variant="ghost"
                onClick={handleReset}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/*                       Project visibility settings card                     */
/* -------------------------------------------------------------------------- */

type ProjectVisibilitySectionProps = {
  project: Project | null;
  isTeamAdmin: boolean;
  onChange: (next: ProjectVisibility) => void | Promise<void>;
};

function ProjectVisibilitySection({
  project,
  isTeamAdmin,
  onChange,
}: ProjectVisibilitySectionProps) {
  const selectId = useId();
  const helperId = useId();
  const [pending, setPending] = useState(false);

  const handleChange = useCallback(
    async (raw: string) => {
      if (raw !== "public" && raw !== "private") return;
      setPending(true);
      try {
        await onChange(raw);
      } finally {
        setPending(false);
      }
    },
    [onChange],
  );

  if (!project) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Project visibility</CardTitle>
          <CardDescription>
            Control who in your workspace can see this team&apos;s project.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300"
          >
            <ShieldAlert
              className="mt-0.5 h-4 w-4 shrink-0"
              aria-hidden="true"
            />
            <span>
              You don&apos;t have access to this project. Ask a team admin to
              add you to the team or to make the project public.
            </span>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Project visibility</CardTitle>
        <CardDescription>
          Control who in your workspace can see{" "}
          <span className="font-medium text-foreground">{project.name}</span>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor={selectId}>Visibility</Label>
          {isTeamAdmin ? (
            <div className="flex items-center gap-3">
              <Select
                value={project.visibility}
                onValueChange={(next) => void handleChange(next)}
                disabled={pending}
              >
                <SelectTrigger
                  id={selectId}
                  aria-describedby={helperId}
                  className="w-full max-w-sm"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="public">
                    <span className="inline-flex items-center gap-2">
                      <Globe2 className="h-4 w-4" aria-hidden="true" />
                      Public
                    </span>
                  </SelectItem>
                  <SelectItem value="private">
                    <span className="inline-flex items-center gap-2">
                      <Lock className="h-4 w-4" aria-hidden="true" />
                      Private
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
              {pending ? (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  Saving…
                </span>
              ) : null}
            </div>
          ) : (
            <VisibilityBadge visibility={project.visibility} />
          )}
        </div>

        <div
          id={helperId}
          className="space-y-3 rounded-md border bg-muted/30 px-4 py-3 text-sm"
        >
          <div className="flex items-start gap-3">
            <Globe2
              className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <div>
              <p className="font-medium text-foreground">Public</p>
              <p className="text-muted-foreground">
                Anyone signed in to your workspace can view the project and its
                board. Only team members can edit or move tasks.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Lock
              className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <div>
              <p className="font-medium text-foreground">Private</p>
              <p className="text-muted-foreground">
                Only members of this team can view or edit the project.
                Non-members in your workspace won&apos;t see it in the projects
                directory.
              </p>
            </div>
          </div>
        </div>

        {!isTeamAdmin ? (
          <p className="text-xs text-muted-foreground">
            Only team admins can change project visibility.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Visibility badge                              */
/* -------------------------------------------------------------------------- */

function VisibilityBadge({
  visibility,
}: {
  visibility: ProjectVisibility;
}) {
  if (visibility === "public") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
        <Globe2 className="h-3 w-3" aria-hidden="true" />
        Public
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
      <Lock className="h-3 w-3" aria-hidden="true" />
      Private
    </span>
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
      <span>Loading settings…</span>
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
        <Settings
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
