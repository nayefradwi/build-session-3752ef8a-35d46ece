"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { AlertCircle, Loader2, UserMinus, Users } from "lucide-react";

import { ApiError, apiClient } from "@/lib/client/api-client";
import { cn } from "@/lib/client/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
} from "@/components/ui/select";

/* -------------------------------------------------------------------------- */
/*                                Public API                                  */
/* -------------------------------------------------------------------------- */

/**
 * Slice of a team member needed to populate the dropdown.
 *
 * Mirrors the shape returned by `GET /api/teams/[teamId]/members` (which
 * itself reshapes the team-detail payload onto a key the create/edit
 * endpoints accept verbatim on `assigneeId`).
 */
export type AssigneeMember = {
  /** users.id — drop straight into the form's `assigneeId` field. */
  id: string;
  /** Optional display name. Falls back to email when null. */
  name: string | null;
  email: string;
};

export type AssigneeSelectProps = {
  /**
   * Forwarded to the trigger so a parent `<Label htmlFor>` can target it.
   * When omitted we generate a stable id internally.
   */
  id?: string;
  /**
   * Team whose membership populates the dropdown.
   *
   * If `members` is also passed, the prefetched list is used and no network
   * request fires. If `members` is omitted, the component fetches via
   * `GET /api/teams/[teamId]/members` on mount (and again whenever `teamId`
   * changes), so a callsite that doesn't already have a roster on hand can
   * just pass `teamId` and get a working dropdown.
   */
  teamId: string;
  /**
   * Currently-selected assignee id. `null` represents "Unassigned" — the
   * server contract for the create/edit endpoints is `assigneeId: string | null`,
   * and we mirror that here so the value can flow straight into the payload
   * without a translation step.
   */
  value: string | null;
  /** Notifies the parent of a selection change. `null` clears the assignee. */
  onChange: (next: string | null) => void;
  /** Disable the trigger (typically while a parent form is submitting). */
  disabled?: boolean;
  /**
   * Optional pre-loaded membership list. When provided, the component skips
   * its own fetch — useful for parents (like the kanban board) that already
   * fetch the team detail and want to avoid a duplicate round-trip per dialog
   * open.
   */
  members?: AssigneeMember[];
  /**
   * Optional fallback assignee surfaced as an extra option when the current
   * value isn't in the supplied roster (e.g. the assignee was removed from
   * the team between dialog-open and now). Without this, the trigger would
   * read as "Unassigned" even though the underlying value is set, silently
   * misleading the user. Pass the task's currently-saved assignee here to
   * keep the picked-state honest.
   */
  currentAssignee?: AssigneeMember | null;
  /**
   * Wires `aria-describedby` on the trigger so a sibling hint / error region
   * is announced together with the control.
   */
  "aria-describedby"?: string;
};

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

/**
 * Sentinel value for "Unassigned". Radix Select forbids the empty string as
 * a value, so we encode the null state with a string the server can never
 * mint as a real userId. Translated back to `null` at the `onChange`
 * boundary so callers never see this constant.
 */
const UNASSIGNED_VALUE = "__unassigned__";

/**
 * Two-character initials. Mirrors the helper used in
 * {@link import("./board-task-card").BoardTaskCard} and the task detail modal
 * so the avatar affordance reads consistently across surfaces. Falls back to
 * "?" when neither name nor email yield usable text — defensive, since the
 * API guarantees email is present.
 */
const initialsFromMember = (member: AssigneeMember): string => {
  const source = (member.name ?? member.email).trim();
  if (!source) return "?";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

const sortMembers = (members: AssigneeMember[]): AssigneeMember[] => {
  // Name (case-insensitive) then email so the list reads the same way on every
  // open. Emails serve as a deterministic tiebreaker.
  const copy = [...members];
  copy.sort((a, b) => {
    const an = (a.name ?? "").toLowerCase();
    const bn = (b.name ?? "").toLowerCase();
    if (an !== bn) return an < bn ? -1 : 1;
    return a.email < b.email ? -1 : a.email > b.email ? 1 : 0;
  });
  return copy;
};

/**
 * Wire shape of `GET /api/teams/[teamId]/members`. The route's doc-comment
 * pins the field set explicitly — `id` is the canonical key (= users.id) and
 * `userId` is preserved as a legacy alias. We only consume `id` here.
 */
type MembersResponse = {
  members: Array<{
    id: string;
    userId: string;
    name: string | null;
    email: string;
    role: "admin" | "member";
    joinedAt: string;
  }>;
};

/* -------------------------------------------------------------------------- */
/*                                 Component                                  */
/* -------------------------------------------------------------------------- */

/**
 * Reusable assignee picker shared by the Create Task dialog and the Edit
 * Task form inside the task-detail modal.
 *
 * Behavior:
 *
 *   - Renders as a shadcn/ui Select. The trigger shows the picked member's
 *     avatar (initials fallback) + name (or email if no name is set), or a
 *     muted "Unassign" affordance when `value === null`.
 *   - Always offers an explicit "Unassign" option at the top of the menu so
 *     a user can clear an existing assignment without resorting to "Cancel +
 *     re-open". Selecting it surfaces `null` to the parent.
 *   - Sorts the membership list by name (case-insensitive) then email so the
 *     dropdown reads identically across opens. Memoized — re-sorting on every
 *     render would churn the menu and reset typeahead focus.
 *   - Falls back gracefully on data-load failure: if the fetch errors and no
 *     `members` prop was supplied, the trigger becomes a read-only state
 *     showing the current assignee (if any) plus an alert hint, so a stale
 *     edit form can still display the picked value rather than silently
 *     blanking it.
 *
 * Data flow:
 *
 *   - When `members` is provided, the prefetched roster is used directly and
 *     no fetch fires. Used by the kanban board which already loads the team
 *     detail at mount time.
 *   - When `members` is omitted, the component fetches `/api/teams/[teamId]/members`
 *     on mount and on every `teamId` change. The endpoint is tenant-gated and
 *     returns 404 across tenants, so a stale teamId surfaces as an error
 *     state rather than leaking another tenant's data.
 *
 * Accessibility:
 *
 *   - The trigger is a real Radix Select trigger (button under the hood) so
 *     keyboard nav + typeahead come for free.
 *   - The visible avatar inside the trigger is `aria-hidden`; the trigger's
 *     visible text label (member name/email) carries the meaning. The picked
 *     option's full identity (name + email) is also announced via the
 *     SelectValue.
 */
export function AssigneeSelect({
  id: idProp,
  teamId,
  value,
  onChange,
  disabled = false,
  members: membersOverride,
  currentAssignee = null,
  "aria-describedby": ariaDescribedBy,
}: AssigneeSelectProps) {
  const generatedId = useId();
  const triggerId = idProp ?? generatedId;

  // Internal roster + fetch state. When `membersOverride` is supplied we
  // short-circuit the fetch entirely and just mirror the prop into state so
  // the rest of the component's logic stays uniform.
  const [fetchedMembers, setFetchedMembers] = useState<AssigneeMember[] | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // If the parent already has a roster, don't fetch — just clear any
    // residual error state from a previous teamId.
    if (membersOverride !== undefined) {
      setFetchedMembers(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    apiClient
      .get<MembersResponse>(`/api/teams/${teamId}/members`, {
        silent: true,
        skipAuthRedirect: true,
      })
      .then((data) => {
        if (cancelled) return;
        setFetchedMembers(
          data.members.map((m) => ({
            id: m.id,
            name: m.name,
            email: m.email,
          })),
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError) {
          setError(err.message);
        } else {
          setError("Unable to load team members.");
        }
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [teamId, membersOverride]);

  // Pick the active source: prop wins, then internally-fetched list, else
  // empty (initial / errored state).
  const sourceMembers = membersOverride ?? fetchedMembers ?? [];
  const sortedMembers = useMemo(
    () => sortMembers(sourceMembers),
    [sourceMembers],
  );

  // If the picked assignee is no longer in the roster (concurrent removal,
  // or the roster failed to load), surface them as an extra option so the
  // user's existing pick stays representable. Without this the trigger would
  // visually fall back to "Unassigned" even though `value` is non-null.
  const showCurrentFallback =
    value !== null &&
    currentAssignee !== null &&
    currentAssignee.id === value &&
    !sortedMembers.some((m) => m.id === value);

  // Memoize the lookup so the trigger renders the picked label without
  // re-scanning the option list on every keystroke in a sibling field.
  const selected = useMemo<AssigneeMember | null>(() => {
    if (value === null) return null;
    const fromList = sortedMembers.find((m) => m.id === value);
    if (fromList) return fromList;
    if (showCurrentFallback && currentAssignee) return currentAssignee;
    return null;
  }, [currentAssignee, showCurrentFallback, sortedMembers, value]);

  const radixValue = value === null ? UNASSIGNED_VALUE : value;

  const handleChange = (next: string) => {
    onChange(next === UNASSIGNED_VALUE ? null : next);
  };

  // Empty-state copy: distinct messages for "still loading", "errored", and
  // "no one to assign yet" so the user understands why the dropdown is bare.
  const emptyMessage = loading
    ? "Loading team members…"
    : error
      ? "Couldn't load team members."
      : sortedMembers.length === 0 && !showCurrentFallback
        ? "No team members are available to assign yet."
        : null;

  return (
    <div className="space-y-1.5">
      <Select
        value={radixValue}
        onValueChange={handleChange}
        disabled={disabled}
      >
        <SelectTrigger
          id={triggerId}
          aria-describedby={ariaDescribedBy}
          className="h-10"
          // Compact `aria-label` so screen readers announce the picked
          // identity even though the visual label includes an avatar (which
          // we mark `aria-hidden`). Falls back to "Unassigned" / "Loading"
          // states so the announcement always reflects the current value.
          aria-label={
            loading && !membersOverride && selected === null
              ? "Loading assignees"
              : selected
                ? `Assignee: ${selected.name ?? selected.email}`
                : "Assignee: Unassigned"
          }
        >
          {/* Rendered directly inside the trigger (rather than via Radix's
              SelectValue) so the displayed markup is independent of the
              dropdown row markup — the dropdown uses a multi-line member
              row, while the trigger uses a compact single-line summary. */}
          <TriggerLabel
            member={selected}
            loading={loading && !membersOverride}
          />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel className="flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5" aria-hidden="true" />
              Assignee
            </SelectLabel>
            {/* Always-present "Unassign" affordance. Pinned to the top so
                clearing an existing assignment is a one-click target. */}
            <SelectItem value={UNASSIGNED_VALUE}>
              <span className="flex items-center gap-2">
                <span
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
                    "border border-dashed border-muted-foreground/40 text-muted-foreground",
                  )}
                  aria-hidden="true"
                >
                  <UserMinus className="h-3 w-3" />
                </span>
                <span className="text-sm">Unassign</span>
              </span>
            </SelectItem>
            {sortedMembers.length > 0 || showCurrentFallback ? (
              <SelectSeparator />
            ) : null}
            {showCurrentFallback && currentAssignee ? (
              <SelectItem value={currentAssignee.id}>
                <MemberOption
                  member={currentAssignee}
                  hint="current"
                />
              </SelectItem>
            ) : null}
            {sortedMembers.map((member) => (
              <SelectItem key={member.id} value={member.id}>
                <MemberOption member={member} />
              </SelectItem>
            ))}
          </SelectGroup>
          {emptyMessage ? (
            <p
              className={cn(
                "px-2 py-2 text-xs",
                error ? "text-destructive" : "text-muted-foreground",
              )}
              role={error ? "alert" : undefined}
            >
              {emptyMessage}
            </p>
          ) : null}
        </SelectContent>
      </Select>
      {error ? (
        <p className="flex items-center gap-1 text-xs text-destructive" role="alert">
          <AlertCircle className="h-3 w-3" aria-hidden="true" />
          {error}
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Sub-components                                */
/* -------------------------------------------------------------------------- */

/**
 * Label rendered inside the Select trigger. Mirrors the option markup so the
 * trigger reads the same way the picked option does in the dropdown — the
 * single visual delta is the trailing chevron, which the trigger renders.
 */
function TriggerLabel({
  member,
  loading,
}: {
  member: AssigneeMember | null;
  loading: boolean;
}) {
  if (loading && member === null) {
    return (
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        Loading…
      </span>
    );
  }
  if (member === null) {
    return (
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        <span
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
            "border border-dashed border-muted-foreground/40",
          )}
          aria-hidden="true"
        >
          <UserMinus className="h-3 w-3" />
        </span>
        Unassigned
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar className="h-6 w-6 shrink-0" aria-hidden="true">
        <AvatarFallback className="text-[10px]">
          {initialsFromMember(member)}
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0 truncate text-sm">
        {member.name ?? member.email}
      </span>
    </span>
  );
}

/**
 * Single member option rendered inside the dropdown list. Shows the avatar,
 * the display name (or email), and (when both exist) the email as a muted
 * second line so admins can disambiguate two people who share a first name.
 */
function MemberOption({
  member,
  hint,
}: {
  member: AssigneeMember;
  hint?: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar className="h-6 w-6 shrink-0" aria-hidden="true">
        <AvatarFallback className="text-[10px]">
          {initialsFromMember(member)}
        </AvatarFallback>
      </Avatar>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-sm">
          {member.name ?? member.email}
          {hint ? (
            <span className="ml-1 text-xs text-muted-foreground">({hint})</span>
          ) : null}
        </span>
        {member.name ? (
          <span className="truncate text-[11px] text-muted-foreground">
            {member.email}
          </span>
        ) : null}
      </span>
    </span>
  );
}
