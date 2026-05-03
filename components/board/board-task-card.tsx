"use client";

import { cn } from "@/lib/client/utils";
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
  /**
   * Optional click handler. When provided the card becomes a button-shaped
   * affordance (focusable, keyboard-activatable) so the parent can open a
   * task-detail surface — typically the {@link import("./task-detail-modal").TaskDetailModal}.
   * When omitted the card stays a plain, non-interactive surface (the
   * skeleton/placeholder paths use this).
   */
  onSelect?: (task: BoardTask) => void;
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
 * Interaction:
 *   - When `onSelect` is provided the entire card is a `role="button"`
 *     element (we use a real `<button>` so Enter/Space activation comes for
 *     free), and clicking/keyboard-activating the card hands the task back
 *     to the parent — typically to open the task-detail modal.
 *   - When `onSelect` is omitted the card stays a plain `<div>` so callsites
 *     that render skeleton/preview cards don't get the focus ring.
 */
export function BoardTaskCard({ task, onSelect }: BoardTaskCardProps) {
  const interactive = typeof onSelect === "function";
  const cardClassName = cn(
    "block w-full space-y-2 rounded-md border bg-background p-3 text-left shadow-sm transition-colors",
    "hover:border-foreground/30 hover:shadow-md",
    interactive &&
      "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background",
  );

  const inner = (
    <>
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
    </>
  );

  if (interactive) {
    // We render the interactive card as a real `<button>` (rather than a
    // div with role=button) so Enter/Space activation, focus order, and
    // disabled-state semantics all come from the platform. The shadcn Card
    // primitive is a div under the hood and doesn't expose `asChild`, so we
    // borrow its base styling via className rather than its element. The
    // aria-label gives screen-reader users the title up front since the
    // visible label is line-clamped.
    return (
      <button
        type="button"
        onClick={() => onSelect?.(task)}
        aria-label={`Open task: ${task.title}`}
        className={cn(
          "rounded-lg border bg-background text-foreground shadow-sm",
          cardClassName,
        )}
      >
        {inner}
      </button>
    );
  }

  return <Card className={cardClassName}>{inner}</Card>;
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
