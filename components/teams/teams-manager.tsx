"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { useSession } from "next-auth/react";
import { Loader2, Plus, RefreshCw, Users } from "lucide-react";
import { toast } from "sonner";

import { ApiError, apiClient } from "@/lib/client/api-client";
import { cn } from "@/lib/client/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Mirrors the server-side validation in `POST /api/teams`. */
const TEAM_NAME_MAX = 120;

/** Shape returned by `GET /api/teams`. */
type TeamListItem = {
  id: string;
  name: string;
  createdAt: string;
  memberCount: number;
  isMember: boolean;
};

type TeamsListResponse = { teams: TeamListItem[] };

/** Shape returned by `POST /api/teams`. */
type CreatedTeam = {
  id: string;
  name: string;
  tenantId: string;
  createdAt: string;
};
type TeamCreatedResponse = { team: CreatedTeam };

/**
 * Teams directory + admin "create team" surface.
 *
 *   - Lists every team in the caller's tenant via `GET /api/teams` (the
 *     endpoint already returns `memberCount` and per-user `isMember`, so we
 *     don't need a second round-trip for membership state).
 *   - Renders a `Create team` button + dialog only when
 *     `session.user.role === "admin"` — the corresponding `POST /api/teams`
 *     route also enforces this server-side, so this gate is purely UX.
 *   - On a successful POST we optimistically prepend the new team and
 *     immediately refetch so the cached `memberCount` / sort order matches
 *     what the server thinks (handles the case where another admin in the
 *     same tenant created teams concurrently).
 */
export function TeamsManager() {
  const { data: session, status } = useSession();

  const role = session?.user?.role;
  const isAdmin = role === "admin";

  const [teams, setTeams] = useState<TeamListItem[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);

  const loadTeams = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      const data = await apiClient.get<TeamsListResponse>("/api/teams", {
        silent: true,
      });
      setTeams(data.teams ?? []);
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : "Unable to load teams.";
      setListError(message);
    } finally {
      setListLoading(false);
    }
  }, []);

  // Load once we know the session is at least resolved (loading state is fine
  // here because the API will accept any authenticated tenant member, not
  // just admins; but we wait for `unauthenticated` to settle so we don't
  // fire a fetch that's just going to 401).
  useEffect(() => {
    if (status === "loading") return;
    if (status === "unauthenticated") return;
    void loadTeams();
  }, [loadTeams, status]);

  const onTeamCreated = useCallback(
    (team: CreatedTeam) => {
      // Optimistic prepend so the dialog can close immediately and the user
      // sees their new team without waiting for the refetch round-trip.
      setTeams((prev) => {
        if (prev.some((t) => t.id === team.id)) return prev;
        return [
          {
            id: team.id,
            name: team.name,
            createdAt: team.createdAt,
            // The creator is auto-added as the team admin in the same
            // transaction (see app/api/teams/route.ts), so reflect that.
            memberCount: 1,
            isMember: true,
          },
          ...prev,
        ];
      });
      // Re-sync from the server so the canonical sort order (by name asc)
      // and any concurrent inserts from other admins are reflected.
      void loadTeams();
    },
    [loadTeams],
  );

  const sessionLoading = status === "loading";
  const showCount = !sessionLoading && !listError && teams.length > 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {showCount
            ? `${teams.length} ${teams.length === 1 ? "team" : "teams"} in your workspace.`
            : "Browse every team in your tenant. Each team has its own private project board."}
        </p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void loadTeams()}
            disabled={listLoading}
            aria-label="Refresh teams"
          >
            <RefreshCw
              className={cn("h-4 w-4", listLoading && "animate-spin")}
              aria-hidden="true"
            />
            <span>Refresh</span>
          </Button>
          {isAdmin ? (
            <Button
              type="button"
              size="sm"
              onClick={() => setDialogOpen(true)}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              <span>Create team</span>
            </Button>
          ) : null}
        </div>
      </div>

      <TeamsList
        teams={teams}
        loading={listLoading}
        error={listError}
        sessionLoading={sessionLoading}
        isAdmin={isAdmin}
        onCreateClick={() => setDialogOpen(true)}
      />

      {/* Mounted unconditionally on admin so React keeps the dialog state
          stable across re-renders; non-admins never see the trigger so the
          dialog can be skipped entirely. */}
      {isAdmin ? (
        <CreateTeamDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onCreated={onTeamCreated}
        />
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                 Teams list                                 */
/* -------------------------------------------------------------------------- */

type TeamsListProps = {
  teams: TeamListItem[];
  loading: boolean;
  error: string | null;
  sessionLoading: boolean;
  isAdmin: boolean;
  onCreateClick: () => void;
};

function TeamsList({
  teams,
  loading,
  error,
  sessionLoading,
  isAdmin,
  onCreateClick,
}: TeamsListProps) {
  if (sessionLoading || (loading && teams.length === 0)) {
    return (
      <div
        className="flex items-center gap-3 rounded-lg border bg-background px-6 py-10 text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        <span>Loading teams…</span>
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

  if (teams.length === 0) {
    return <TeamsEmptyState isAdmin={isAdmin} onCreateClick={onCreateClick} />;
  }

  return (
    <ul
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
      role="list"
    >
      {teams.map((team) => (
        <li key={team.id} className="h-full">
          <TeamCard team={team} />
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/*                                Team card                                   */
/* -------------------------------------------------------------------------- */

type TeamCardProps = {
  team: TeamListItem;
};

/**
 * Single team tile. Wrapped in a `next/link` so the entire card is clickable
 * (including keyboard nav). The card itself stays a plain `<div>` — the
 * outer anchor handles focus/hover affordances.
 */
function TeamCard({ team }: TeamCardProps) {
  const memberLabel =
    team.memberCount === 1 ? "1 member" : `${team.memberCount} members`;

  return (
    <Link
      href={`/dashboard/teams/${team.id}`}
      aria-label={`Open ${team.name} (${memberLabel}${team.isMember ? ", you are a member" : ""})`}
      className="group block h-full rounded-lg outline-none ring-offset-2 ring-offset-background transition-shadow focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Card className="h-full transition-colors group-hover:border-foreground/30 group-hover:shadow-md">
        <CardHeader className="space-y-2">
          <div className="flex items-start justify-between gap-3">
            <CardTitle className="truncate text-lg leading-snug">
              {team.name}
            </CardTitle>
            {team.isMember ? (
              <span className="inline-flex shrink-0 items-center rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                Member
              </span>
            ) : null}
          </div>
          <CardDescription className="flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{memberLabel}</span>
          </CardDescription>
        </CardHeader>
      </Card>
    </Link>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Empty state                                   */
/* -------------------------------------------------------------------------- */

type TeamsEmptyStateProps = {
  isAdmin: boolean;
  onCreateClick: () => void;
};

function TeamsEmptyState({ isAdmin, onCreateClick }: TeamsEmptyStateProps) {
  return (
    <Card className="border-dashed">
      <CardHeader className="items-center text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Users
            className="h-6 w-6 text-muted-foreground"
            aria-hidden="true"
          />
        </div>
        <CardTitle className="text-xl">No teams yet</CardTitle>
        <CardDescription className="max-w-md">
          {isAdmin
            ? "Create the first team to spin up a private project board and start grouping your members."
            : "Your workspace doesn't have any teams yet. Ask a tenant admin to create one to get started."}
        </CardDescription>
      </CardHeader>
      {isAdmin ? (
        <CardFooter className="justify-center pt-0">
          <Button type="button" onClick={onCreateClick}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Create team
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/*                            Create team dialog                              */
/* -------------------------------------------------------------------------- */

type CreateTeamDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (team: CreatedTeam) => void;
};

function CreateTeamDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateTeamDialogProps) {
  const nameInputId = useId();
  const errorId = useId();

  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Reset transient form state every time the dialog closes — without this,
  // an aborted submit would re-show the previous error on next open.
  useEffect(() => {
    if (!open) {
      setName("");
      setNameError(null);
      setSubmitting(false);
    }
  }, [open]);

  const trimmedLength = useMemo(() => name.trim().length, [name]);

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submitting) return;

      const trimmed = name.trim();
      if (!trimmed) {
        setNameError("Team name is required.");
        return;
      }
      if (trimmed.length > TEAM_NAME_MAX) {
        setNameError(`Team name must be ${TEAM_NAME_MAX} characters or fewer.`);
        return;
      }
      setNameError(null);
      setSubmitting(true);

      try {
        const data = await apiClient.post<TeamCreatedResponse>(
          "/api/teams",
          { name: trimmed },
          { silent: true, skipAuthRedirect: true },
        );

        toast.success("Team created", {
          description: `${data.team.name} is ready to go.`,
        });
        onCreated(data.team);
        onOpenChange(false);
      } catch (err) {
        if (err instanceof ApiError) {
          // 403 means the session role isn't admin — the button shouldn't
          // even be visible in that case, but we still surface a clear
          // toast in the rare race (role downgraded mid-session).
          if (err.code === "INVALID_INPUT") {
            setNameError(err.message);
          }
          toast.error("Couldn't create team", {
            description: err.message,
          });
        } else {
          toast.error("Couldn't create team", {
            description: "Something went wrong. Please try again.",
          });
        }
      } finally {
        setSubmitting(false);
      }
    },
    [name, onCreated, onOpenChange, submitting],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Don't let the user dismiss while a submission is in flight —
        // closing would leave the optimistic add unsynced.
        if (submitting && !next) return;
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a team</DialogTitle>
          <DialogDescription>
            We&apos;ll set up a private project and a default kanban board for
            this team automatically.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={onSubmit} noValidate>
          <div className="space-y-2">
            <Label htmlFor={nameInputId}>Team name</Label>
            <Input
              id={nameInputId}
              name="name"
              type="text"
              autoComplete="off"
              autoFocus
              maxLength={TEAM_NAME_MAX}
              placeholder="Marketing, Platform, Design…"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                if (nameError) setNameError(null);
              }}
              aria-invalid={Boolean(nameError)}
              aria-describedby={nameError ? errorId : undefined}
              disabled={submitting}
              required
            />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Visible to everyone in your tenant.</span>
              <span aria-live="polite">
                {trimmedLength}/{TEAM_NAME_MAX}
              </span>
            </div>
            {nameError ? (
              <p id={errorId} className="text-sm text-destructive" role="alert">
                {nameError}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || trimmedLength === 0}>
              {submitting ? (
                <>
                  <Loader2 className="animate-spin" aria-hidden="true" />
                  Creating…
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  Create team
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
