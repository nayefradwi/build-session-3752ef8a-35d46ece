"use client";

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
  CardContent,
  CardDescription,
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

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="text-xl">Teams in your workspace</CardTitle>
            <CardDescription>
              Browse every team in your tenant. Each team has its own private
              project board.
            </CardDescription>
          </div>
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
        </CardHeader>
        <CardContent>
          <TeamsList
            teams={teams}
            loading={listLoading}
            error={listError}
            sessionLoading={status === "loading"}
          />
        </CardContent>
      </Card>

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
};

function TeamsList({ teams, loading, error, sessionLoading }: TeamsListProps) {
  if (sessionLoading || (loading && teams.length === 0)) {
    return (
      <div className="flex items-center gap-3 py-6 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        <span>Loading teams…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        {error}
      </div>
    );
  }

  if (teams.length === 0) {
    return (
      <div className="flex flex-col items-start gap-2 py-6 text-sm text-muted-foreground">
        <Users
          className="h-5 w-5 text-muted-foreground/70"
          aria-hidden="true"
        />
        <p>No teams yet. Admins can create the first one above.</p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border rounded-md border">
      {teams.map((team) => (
        <li
          key={team.id}
          className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{team.name}</p>
            <p className="text-xs text-muted-foreground">
              {team.memberCount === 1
                ? "1 member"
                : `${team.memberCount} members`}
              {team.isMember ? " · You're a member" : ""}
            </p>
          </div>
          {team.isMember ? (
            <span className="inline-flex w-fit items-center rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
              Member
            </span>
          ) : null}
        </li>
      ))}
    </ul>
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
