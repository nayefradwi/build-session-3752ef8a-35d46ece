"use client";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import type { BoardTask, BoardTaskAssignee } from "@/components/board/types";

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

/**
 * Two-character initials fallback for the assignee avatar.
 *
 * Mirrors the helper used in `team-members-manager.tsx` so the avatar
 * affordance reads consistently across surfaces. Falls back to "?" when
 * neither name nor email are usable (defensive — the API guarantees email
 * is non-null).
 */
const initialsFromAssignee = (assignee: BoardTaskAssignee): string => {
  const source = (assignee.name ?? assignee.email).trim();
  if (!source) return "?";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

/* -------------------------------------------------------------------------- */
/*                                 Task card                                  */
/* -------------------------------------------------------------------------- */

type BoardTaskCardProps = {
  task: BoardTask;
};

/**
 * Single task on the board.
 *
 *   - Title is the primary affordance — clamped to two lines so a runaway
 *     title can't blow up the lane height.
 *   - Description (if present) renders as a one-line preview, also clamped.
 *   - Assignee, if present, renders as a small avatar (initials only — the
 *     users table only stores an `image` URL on the profile, but the tasks
 *     endpoint does not currently include it on the inlined slice). The
 *     avatar carries the full name/email as a tooltip via `title` so a hover
 *     surfaces the full identity without needing a popover.
 *
 * The card is a plain surface today — no click handler, no drag handle. The
 * outer `<li>` makes it landmark-addressable in the column list, and we
 * keep the markup hook-free so a follow-up can layer task-detail navigation
 * (e.g. wrap in `<Link href={`/tasks/${task.id}`}>`) without restructuring.
 */
export function BoardTaskCard({ task }: BoardTaskCardProps) {
  return (
    <Card className="space-y-2 rounded-md border bg-background p-3 shadow-sm transition-colors hover:border-foreground/30 hover:shadow-md">
      <p className="line-clamp-2 text-sm font-medium leading-snug">
        {task.title}
      </p>

      {task.description ? (
        <p className="line-clamp-1 text-xs text-muted-foreground">
          {task.description}
        </p>
      ) : null}

      <div className="flex items-center justify-end pt-1">
        {task.assignee ? (
          <AssigneeAvatar assignee={task.assignee} />
        ) : (
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground/70">
            Unassigned
          </span>
        )}
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/*                            Assignee avatar                                 */
/* -------------------------------------------------------------------------- */

function AssigneeAvatar({ assignee }: { assignee: BoardTaskAssignee }) {
  const label = assignee.name ?? assignee.email;
  const initials = initialsFromAssignee(assignee);

  return (
    <Avatar
      // Smaller than the default 9×9 used in the members table — the card is
      // dense and a 9×9 avatar would dominate the metadata row.
      className="h-6 w-6"
      title={label}
      aria-label={`Assigned to ${label}`}
    >
      <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
    </Avatar>
  );
}
