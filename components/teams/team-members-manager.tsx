"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { useSession } from "next-auth/react";
import {
  AlertCircle,
  ArrowLeft,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { ApiError, apiClient } from "@/lib/client/api-client";
import { cn } from "@/lib/client/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
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

/** Mirrors a row from `GET /api/teams`. */
type TenantTeam = {
  id: string;
  name: string;
  createdAt: string;
  memberCount: number;
  isMember: boolean;
};

type TenantTeamsResponse = { teams: TenantTeam[] };

/** Candidate user we surface in the "Add member" dialog. */
type CandidateUser = {
  userId: string;
  email: string;
  name: string | null;
  image: string | null;
};

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

const initialsFromMember = (member: {
  name: string | null;
  email: string;
}): string => {
  const source = (member.name ?? member.email).trim();
  if (!source) return "?";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

/**
 * Tally the admins in a member list. Used both for the "last admin" guard on
 * remove/demote and to render the headline "X admins, Y members" stat.
 */
const countByRole = (
  members: readonly TeamMember[],
): { admins: number; members: number } => {
  let admins = 0;
  for (const m of members) if (m.role === "admin") admins += 1;
  return { admins, members: members.length - admins };
};

/* -------------------------------------------------------------------------- */
/*                            Top-level component                             */
/* -------------------------------------------------------------------------- */

type TeamMembersManagerProps = {
  teamId: string;
};

/**
 * Members management surface for a single team.
 *
 *   - Loads the team detail (`GET /api/teams/[teamId]`), which returns the
 *     team metadata plus the full membership list with each member's per-team
 *     role and a small profile slice (name, email, image). One round trip is
 *     enough to render the table.
 *   - Determines `isTeamAdmin` from the current session: true iff the caller
 *     has `role === "admin"` on this team. Tenant-level admins do NOT bypass
 *     the per-team role gate (mirroring the server-side check in the CRUD
 *     handlers).
 *   - For team admins: renders the Add Member button + dialog, the per-row
 *     role select (admin↔member), and the per-row remove confirm dialog. The
 *     last-admin invariant is enforced client-side too (UI disables the
 *     destructive controls) so the user gets immediate feedback before the
 *     server returns 409 LAST_ADMIN.
 *   - All mutations show a sonner toast and refetch the team detail so the
 *     local state matches the server. The refetch is cheap (one query) and
 *     keeps things simple — no diffing or optimistic patching that could
 *     drift from the canonical state.
 */
export function TeamMembersManager({ teamId }: TeamMembersManagerProps) {
  const { data: session, status: sessionStatus } = useSession();
  const callerId = session?.user?.id ?? null;

  const [team, setTeam] = useState<TeamSummary | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  // Per-row pending state: maps a userId to the kind of mutation in flight.
  // Used to disable the row's controls while a request is on the wire so the
  // user can't double-click into a 409.
  const [pendingByUser, setPendingByUser] = useState<
    Record<string, "role" | "remove">
  >({});

  // Dialog state lives at this level so opening the Add dialog from anywhere
  // in the tree (header button or empty state) stays in sync.
  const [addOpen, setAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<TeamMember | null>(null);

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
          err instanceof ApiError
            ? err.message
            : "Unable to load team members.";
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

  // Caller's per-team membership row, if any. The Add / role-change / remove
  // controls are gated on `callerMembership?.role === "admin"`.
  const callerMembership = useMemo(() => {
    if (!callerId) return null;
    return members.find((m) => m.userId === callerId) ?? null;
  }, [callerId, members]);

  const isTeamAdmin = callerMembership?.role === "admin";
  const adminCount = useMemo(() => countByRole(members).admins, [members]);

  const setRowPending = useCallback(
    (userId: string, kind: "role" | "remove" | null) => {
      setPendingByUser((prev) => {
        const next = { ...prev };
        if (kind === null) {
          delete next[userId];
        } else {
          next[userId] = kind;
        }
        return next;
      });
    },
    [],
  );

  /* --------------------------- Mutation handlers -------------------------- */

  const onChangeRole = useCallback(
    async (member: TeamMember, nextRole: TeamRole) => {
      if (member.role === nextRole) return;
      setRowPending(member.userId, "role");
      try {
        await apiClient.put(
          `/api/teams/${teamId}/members/${member.userId}`,
          { role: nextRole },
          { silent: true, skipAuthRedirect: true },
        );
        toast.success(
          nextRole === "admin" ? "Promoted to admin" : "Demoted to member",
          {
            description: `${member.name ?? member.email} is now a team ${nextRole}.`,
          },
        );
        await loadTeam();
      } catch (err) {
        if (err instanceof ApiError && err.code === "LAST_ADMIN") {
          toast.error("Can't demote the last admin", {
            description:
              "Promote another member to admin first, then demote this one.",
          });
        } else if (err instanceof ApiError) {
          toast.error("Couldn't change role", { description: err.message });
        } else {
          toast.error("Couldn't change role", {
            description: "Something went wrong. Please try again.",
          });
        }
      } finally {
        setRowPending(member.userId, null);
      }
    },
    [loadTeam, setRowPending, teamId],
  );

  const onRemoveMember = useCallback(
    async (member: TeamMember) => {
      setRowPending(member.userId, "remove");
      try {
        await apiClient.delete(
          `/api/teams/${teamId}/members/${member.userId}`,
          { silent: true, skipAuthRedirect: true },
        );
        toast.success("Member removed", {
          description: `${member.name ?? member.email} has been removed from the team.`,
        });
        setRemoveTarget(null);
        await loadTeam();
      } catch (err) {
        if (err instanceof ApiError && err.code === "LAST_ADMIN") {
          toast.error("Can't remove the last admin", {
            description:
              "Promote another member to admin first, then remove this one.",
          });
        } else if (err instanceof ApiError) {
          toast.error("Couldn't remove member", { description: err.message });
        } else {
          toast.error("Couldn't remove member", {
            description: "Something went wrong. Please try again.",
          });
        }
      } finally {
        setRowPending(member.userId, null);
      }
    },
    [loadTeam, setRowPending, teamId],
  );

  const onMemberAdded = useCallback(async () => {
    setAddOpen(false);
    await loadTeam();
  }, [loadTeam]);

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

  const memberCount = members.length;

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <Button asChild variant="ghost" size="sm" className="-ml-3">
          <Link href="/teams">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            All teams
          </Link>
        </Button>
        <div className="space-y-1">
          <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Team
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">
            {team?.name ?? "Team"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {memberCount} {memberCount === 1 ? "member" : "members"} ·{" "}
            {adminCount} {adminCount === 1 ? "admin" : "admins"}
            {isTeamAdmin
              ? " · You're a team admin"
              : callerMembership
                ? " · You're a member"
                : ""}
          </p>
        </div>
      </header>

      <section className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-lg font-semibold">Members</h2>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void loadTeam()}
              disabled={loading}
              aria-label="Refresh members"
            >
              <RefreshCw
                className={cn("h-4 w-4", loading && "animate-spin")}
                aria-hidden="true"
              />
              <span>Refresh</span>
            </Button>
            {isTeamAdmin ? (
              <Button
                type="button"
                size="sm"
                onClick={() => setAddOpen(true)}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                <span>Add member</span>
              </Button>
            ) : null}
          </div>
        </div>

        <MembersTable
          members={members}
          isTeamAdmin={isTeamAdmin}
          callerId={callerId}
          adminCount={adminCount}
          pendingByUser={pendingByUser}
          onChangeRole={onChangeRole}
          onRequestRemove={(m) => setRemoveTarget(m)}
        />
      </section>

      {isTeamAdmin && team ? (
        <AddMemberDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          team={team}
          existingMembers={members}
          onAdded={onMemberAdded}
        />
      ) : null}

      <RemoveMemberDialog
        member={removeTarget}
        adminCount={adminCount}
        pending={
          removeTarget !== null &&
          pendingByUser[removeTarget.userId] === "remove"
        }
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => {
          if (removeTarget) void onRemoveMember(removeTarget);
        }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Members table                                 */
/* -------------------------------------------------------------------------- */

type MembersTableProps = {
  members: TeamMember[];
  isTeamAdmin: boolean;
  callerId: string | null;
  adminCount: number;
  pendingByUser: Record<string, "role" | "remove">;
  onChangeRole: (member: TeamMember, role: TeamRole) => void;
  onRequestRemove: (member: TeamMember) => void;
};

function MembersTable({
  members,
  isTeamAdmin,
  callerId,
  adminCount,
  pendingByUser,
  onChangeRole,
  onRequestRemove,
}: MembersTableProps) {
  if (members.length === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-background px-6 py-10 text-center">
        <Users
          className="mx-auto h-8 w-8 text-muted-foreground"
          aria-hidden="true"
        />
        <p className="mt-2 text-sm font-medium">No members yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {isTeamAdmin
            ? "Add a member to get started."
            : "Ask a team admin to add members."}
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      {/* Desktop / tablet table view. On narrow viewports we hide the table
          and render a stacked card list (below) so each row stays readable
          without horizontal scrolling. */}
      <table className="hidden w-full text-sm md:table" role="table">
        <thead className="bg-muted/40 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <tr>
            <th scope="col" className="px-4 py-3">
              Member
            </th>
            <th scope="col" className="px-4 py-3">
              Email
            </th>
            <th scope="col" className="px-4 py-3">
              Role
            </th>
            {isTeamAdmin ? (
              <th scope="col" className="px-4 py-3 text-right">
                <span className="sr-only">Actions</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody className="divide-y">
          {members.map((member) => (
            <MemberRow
              key={member.userId}
              member={member}
              isTeamAdmin={isTeamAdmin}
              isSelf={member.userId === callerId}
              isLastAdmin={member.role === "admin" && adminCount <= 1}
              pending={pendingByUser[member.userId] ?? null}
              onChangeRole={onChangeRole}
              onRequestRemove={onRequestRemove}
            />
          ))}
        </tbody>
      </table>

      {/* Mobile stacked cards. */}
      <ul className="divide-y md:hidden" role="list">
        {members.map((member) => (
          <MemberCard
            key={member.userId}
            member={member}
            isTeamAdmin={isTeamAdmin}
            isSelf={member.userId === callerId}
            isLastAdmin={member.role === "admin" && adminCount <= 1}
            pending={pendingByUser[member.userId] ?? null}
            onChangeRole={onChangeRole}
            onRequestRemove={onRequestRemove}
          />
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Single member row                             */
/* -------------------------------------------------------------------------- */

type MemberRowProps = {
  member: TeamMember;
  isTeamAdmin: boolean;
  isSelf: boolean;
  isLastAdmin: boolean;
  pending: "role" | "remove" | null;
  onChangeRole: (member: TeamMember, role: TeamRole) => void;
  onRequestRemove: (member: TeamMember) => void;
};

function MemberRow({
  member,
  isTeamAdmin,
  isSelf,
  isLastAdmin,
  pending,
  onChangeRole,
  onRequestRemove,
}: MemberRowProps) {
  return (
    <tr className="text-sm">
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <Avatar className="h-8 w-8">
            {member.image ? (
              <AvatarImage src={member.image} alt="" />
            ) : null}
            <AvatarFallback>{initialsFromMember(member)}</AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-medium">
              {member.name ?? member.email}
              {isSelf ? (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  (you)
                </span>
              ) : null}
            </span>
          </div>
        </div>
      </td>
      <td className="px-4 py-3 text-muted-foreground">
        <span className="block max-w-[18rem] truncate" title={member.email}>
          {member.email}
        </span>
      </td>
      <td className="px-4 py-3">
        {isTeamAdmin ? (
          <RoleSelect
            role={member.role}
            disabled={isLastAdmin || pending !== null}
            disabledReason={
              isLastAdmin
                ? "Promote another member to admin before demoting the last admin."
                : undefined
            }
            onChange={(next) => onChangeRole(member, next)}
            label={`Change role for ${member.name ?? member.email}`}
          />
        ) : (
          <RoleBadge role={member.role} />
        )}
      </td>
      {isTeamAdmin ? (
        <td className="px-4 py-3 text-right">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={isLastAdmin || pending !== null}
            title={
              isLastAdmin
                ? "Promote another member to admin before removing the last admin."
                : undefined
            }
            onClick={() => onRequestRemove(member)}
            aria-label={`Remove ${member.name ?? member.email}`}
          >
            {pending === "remove" ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            )}
            <span>Remove</span>
          </Button>
        </td>
      ) : null}
    </tr>
  );
}

type MemberCardProps = MemberRowProps;

function MemberCard({
  member,
  isTeamAdmin,
  isSelf,
  isLastAdmin,
  pending,
  onChangeRole,
  onRequestRemove,
}: MemberCardProps) {
  return (
    <li className="flex flex-col gap-3 px-4 py-4">
      <div className="flex items-center gap-3">
        <Avatar className="h-9 w-9">
          {member.image ? <AvatarImage src={member.image} alt="" /> : null}
          <AvatarFallback>{initialsFromMember(member)}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">
            {member.name ?? member.email}
            {isSelf ? (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                (you)
              </span>
            ) : null}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {member.email}
          </span>
        </div>
        <RoleBadge role={member.role} />
      </div>

      {isTeamAdmin ? (
        <div className="flex items-center justify-between gap-2">
          <RoleSelect
            role={member.role}
            disabled={isLastAdmin || pending !== null}
            disabledReason={
              isLastAdmin
                ? "Promote another member to admin before demoting the last admin."
                : undefined
            }
            onChange={(next) => onChangeRole(member, next)}
            label={`Change role for ${member.name ?? member.email}`}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={isLastAdmin || pending !== null}
            onClick={() => onRequestRemove(member)}
            aria-label={`Remove ${member.name ?? member.email}`}
          >
            {pending === "remove" ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            )}
            <span>Remove</span>
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Role badge / select                           */
/* -------------------------------------------------------------------------- */

function RoleBadge({ role }: { role: TeamRole }) {
  if (role === "admin") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
        <ShieldCheck className="h-3 w-3" aria-hidden="true" />
        Admin
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      Member
    </span>
  );
}

type RoleSelectProps = {
  role: TeamRole;
  disabled: boolean;
  disabledReason?: string;
  onChange: (role: TeamRole) => void;
  label: string;
};

/**
 * Inline role select rendered as a styled native `<select>`. We deliberately
 * keep it a native control rather than a Radix Select primitive — there's no
 * `Select` shadcn component installed in this project yet, and a native
 * select is keyboard- and screen-reader-accessible out of the box.
 */
function RoleSelect({
  role,
  disabled,
  disabledReason,
  onChange,
  label,
}: RoleSelectProps) {
  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value as TeamRole;
    if (next !== "admin" && next !== "member") return;
    onChange(next);
  };

  return (
    <select
      value={role}
      onChange={handleChange}
      disabled={disabled}
      aria-label={label}
      title={disabled ? disabledReason : undefined}
      className={cn(
        "h-9 rounded-md border border-input bg-background px-2 text-sm",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-60",
      )}
    >
      <option value="admin">Admin</option>
      <option value="member">Member</option>
    </select>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Add member dialog                             */
/* -------------------------------------------------------------------------- */

type AddMemberDialogProps = {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  team: TeamSummary;
  existingMembers: TeamMember[];
  onAdded: () => void | Promise<void>;
};

/**
 * "Add member" dialog with a searchable list of candidate users.
 *
 * There's currently no `GET /api/tenant/users` endpoint, so we approximate
 * the tenant directory by aggregating members across every team in the
 * tenant: `GET /api/teams` to enumerate teams, then `GET /api/teams/[teamId]`
 * for each team and dedupe by `userId`. Users who have never been added to
 * any team won't surface here — that's the known gap, and swapping in a real
 * tenant-users endpoint is a one-line change in `loadCandidates`.
 *
 * Candidates already in this team are filtered out client-side so the user
 * never sees a no-op option that would 409 on submit.
 */
function AddMemberDialog({
  open,
  onOpenChange,
  team,
  existingMembers,
  onAdded,
}: AddMemberDialogProps) {
  const searchInputId = useId();
  const listboxId = useId();

  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<CandidateUser[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Race guard: if the user closes & reopens the dialog quickly, an in-flight
  // candidate fetch from a previous open shouldn't blat fresh state. Each
  // load gets a token and only the latest one writes back.
  const loadTokenRef = useRef(0);

  const existingIds = useMemo(
    () => new Set(existingMembers.map((m) => m.userId)),
    [existingMembers],
  );

  const loadCandidates = useCallback(async () => {
    const token = ++loadTokenRef.current;
    setCandidatesLoading(true);
    setCandidatesError(null);
    try {
      const teamsResp = await apiClient.get<TenantTeamsResponse>(
        "/api/teams",
        { silent: true },
      );

      const otherTeams = teamsResp.teams.filter((t) => t.id !== team.id);

      // Fan out per-team detail fetches in parallel. Failures on individual
      // teams (e.g. 404 if a team got deleted between the list and the
      // detail) are tolerated — we just skip them.
      const detailResults = await Promise.allSettled(
        otherTeams.map((t) =>
          apiClient.get<TeamDetailResponse>(`/api/teams/${t.id}`, {
            silent: true,
          }),
        ),
      );

      const seen = new Map<string, CandidateUser>();
      for (const result of detailResults) {
        if (result.status !== "fulfilled") continue;
        for (const m of result.value.members) {
          if (existingIds.has(m.userId)) continue;
          if (seen.has(m.userId)) continue;
          seen.set(m.userId, {
            userId: m.userId,
            email: m.email,
            name: m.name,
            image: m.image,
          });
        }
      }

      // Stable sort: name (case-insensitive) then email so the list reads
      // the same way on every open.
      const list = [...seen.values()].sort((a, b) => {
        const an = (a.name ?? "").toLowerCase();
        const bn = (b.name ?? "").toLowerCase();
        if (an !== bn) return an < bn ? -1 : 1;
        return a.email < b.email ? -1 : a.email > b.email ? 1 : 0;
      });

      if (loadTokenRef.current !== token) return;
      setCandidates(list);
    } catch (err) {
      if (loadTokenRef.current !== token) return;
      const message =
        err instanceof ApiError ? err.message : "Unable to load users.";
      setCandidatesError(message);
    } finally {
      if (loadTokenRef.current === token) setCandidatesLoading(false);
    }
  }, [existingIds, team.id]);

  // Refresh candidates every time the dialog opens. The user may have added
  // someone in another tab between opens; refetching keeps the list honest.
  useEffect(() => {
    if (!open) {
      // Reset transient form state on close so the next open is clean.
      setQuery("");
      setSelectedUserId(null);
      setSubmitting(false);
      return;
    }
    void loadCandidates();
  }, [loadCandidates, open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((c) => {
      const haystack = `${c.name ?? ""} ${c.email}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [candidates, query]);

  const onSubmit = useCallback(async () => {
    if (!selectedUserId || submitting) return;
    const target = candidates.find((c) => c.userId === selectedUserId);
    setSubmitting(true);
    try {
      await apiClient.post(
        `/api/teams/${team.id}/members`,
        { userId: selectedUserId, role: "member" },
        { silent: true, skipAuthRedirect: true },
      );
      toast.success("Member added", {
        description: target?.name
          ? `${target.name} has been added to the team.`
          : target
            ? `${target.email} has been added to the team.`
            : "Member has been added to the team.",
      });
      await onAdded();
    } catch (err) {
      if (err instanceof ApiError && err.code === "CONFLICT") {
        toast.error("Already a member", {
          description: "This user is already a member of this team.",
        });
      } else if (err instanceof ApiError) {
        toast.error("Couldn't add member", { description: err.message });
      } else {
        toast.error("Couldn't add member", {
          description: "Something went wrong. Please try again.",
        });
      }
    } finally {
      setSubmitting(false);
    }
  }, [candidates, onAdded, selectedUserId, submitting, team.id]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Don't dismiss while a submission is in flight — closing here would
        // still send the request but the user wouldn't see the result.
        if (submitting && !next) return;
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a member</DialogTitle>
          <DialogDescription>
            Search and select a user from your workspace to add to{" "}
            <span className="font-medium text-foreground">{team.name}</span>.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={searchInputId}>Search users</Label>
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                id={searchInputId}
                type="search"
                autoComplete="off"
                placeholder="Name or email…"
                className="pl-9"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                disabled={submitting}
                aria-controls={listboxId}
              />
            </div>
          </div>

          <CandidateList
            id={listboxId}
            loading={candidatesLoading}
            error={candidatesError}
            onRetry={() => void loadCandidates()}
            candidates={filtered}
            totalCandidates={candidates.length}
            query={query}
            selectedUserId={selectedUserId}
            onSelect={setSelectedUserId}
            submitting={submitting}
          />
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
          <Button
            type="button"
            onClick={() => void onSubmit()}
            disabled={!selectedUserId || submitting}
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Adding…
              </>
            ) : (
              <>
                <Plus className="h-4 w-4" aria-hidden="true" />
                Add member
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type CandidateListProps = {
  id: string;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  candidates: CandidateUser[];
  totalCandidates: number;
  query: string;
  selectedUserId: string | null;
  onSelect: (userId: string) => void;
  submitting: boolean;
};

function CandidateList({
  id,
  loading,
  error,
  onRetry,
  candidates,
  totalCandidates,
  query,
  selectedUserId,
  onSelect,
  submitting,
}: CandidateListProps) {
  if (loading) {
    return (
      <div
        id={id}
        className="flex items-center gap-2 rounded-md border bg-background px-3 py-6 text-sm text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        <span>Loading users…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div
        id={id}
        role="alert"
        className="flex items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-3 text-sm text-destructive"
      >
        <div className="flex items-start gap-2">
          <AlertCircle className="mt-0.5 h-4 w-4" aria-hidden="true" />
          <span>{error}</span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRetry}
          disabled={submitting}
        >
          Retry
        </Button>
      </div>
    );
  }

  if (totalCandidates === 0) {
    return (
      <div
        id={id}
        className="rounded-md border border-dashed bg-background px-3 py-6 text-center text-sm text-muted-foreground"
      >
        Everyone in your workspace is already a member of this team.
      </div>
    );
  }

  if (candidates.length === 0) {
    return (
      <div
        id={id}
        className="rounded-md border border-dashed bg-background px-3 py-6 text-center text-sm text-muted-foreground"
      >
        No users match{" "}
        <span className="font-medium text-foreground">“{query}”</span>.
      </div>
    );
  }

  return (
    <ul
      id={id}
      className="max-h-64 divide-y overflow-y-auto rounded-md border bg-background"
      role="listbox"
      aria-label="Candidate users"
    >
      {candidates.map((c) => {
        const isSelected = c.userId === selectedUserId;
        return (
          <li key={c.userId} role="presentation">
            <button
              type="button"
              role="option"
              aria-selected={isSelected}
              onClick={() => onSelect(c.userId)}
              disabled={submitting}
              className={cn(
                "flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-muted",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isSelected && "bg-muted",
              )}
            >
              <Avatar className="h-8 w-8">
                {c.image ? <AvatarImage src={c.image} alt="" /> : null}
                <AvatarFallback>
                  {initialsFromMember({ name: c.name, email: c.email })}
                </AvatarFallback>
              </Avatar>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">
                  {c.name ?? c.email}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {c.email}
                </span>
              </div>
              {isSelected ? (
                <span className="text-xs font-medium text-primary">
                  Selected
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/*                          Remove confirmation dialog                        */
/* -------------------------------------------------------------------------- */

type RemoveMemberDialogProps = {
  member: TeamMember | null;
  adminCount: number;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

function RemoveMemberDialog({
  member,
  adminCount,
  pending,
  onCancel,
  onConfirm,
}: RemoveMemberDialogProps) {
  // Defensive: even though the row's button is disabled when this is the last
  // admin, surface the same guard here so the API never gets a request we
  // know will fail.
  const isLastAdmin = member?.role === "admin" && adminCount <= 1;

  return (
    <Dialog
      open={member !== null}
      onOpenChange={(next) => {
        if (!next && !pending) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove member?</DialogTitle>
          <DialogDescription>
            {member ? (
              <>
                <span className="font-medium text-foreground">
                  {member.name ?? member.email}
                </span>{" "}
                will lose access to this team and any private projects it
                owns. They&apos;ll remain in your workspace.
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        {isLastAdmin ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300"
          >
            <AlertCircle
              className="mt-0.5 h-4 w-4 shrink-0"
              aria-hidden="true"
            />
            <span>
              This is the only admin on the team. Promote another member to
              admin first, then remove this one.
            </span>
          </div>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={onConfirm}
            disabled={pending || isLastAdmin}
          >
            {pending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Removing…
              </>
            ) : (
              <>
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                Remove member
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
