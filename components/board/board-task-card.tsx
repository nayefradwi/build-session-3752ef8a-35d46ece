"use client";

import type { CSSProperties, HTMLAttributes, Ref } from "react";
import { Paperclip } from "lucide-react";

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

/**
 * Deterministic colour palette for the assignee avatar's coloured-circle
 * fallback. Each entry pairs a Tailwind background with a foreground that
 * keeps the two-letter initials legible against it. We pick from this list
 * by hashing the assignee's id so the same person reads as the same colour
 * across every card on the board (and across re-renders).
 *
 * The palette is tuned to read clearly in both light and dark mode — the
 * 500-weight chroma family on Tailwind's defaults gives enough contrast
 * against white text without leaning into accent-clash with the board
 * chrome (which is mostly muted greys). Eight slots are enough variety
 * for a small team without producing two-similar-shades adjacency.
 */
const AVATAR_PALETTE: readonly string[] = [
  "bg-rose-500 text-white",
  "bg-orange-500 text-white",
  "bg-amber-500 text-black",
  "bg-emerald-500 text-white",
  "bg-teal-500 text-white",
  "bg-sky-500 text-white",
  "bg-indigo-500 text-white",
  "bg-fuchsia-500 text-white",
] as const;

/**
 * Stable colour assignment for a given assignee id. We use a tiny
 * deterministic string hash (djb2-like) rather than a crypto digest because
 * the only requirement is "same id → same slot every render", and a 32-bit
 * accumulator over a UUID gives plenty of distribution across an 8-entry
 * palette for any realistic team size.
 *
 * Falls back to the first palette slot when the id is empty (defensive —
 * the API guarantees a UUID).
 */
const colorClassForAssignee = (assignee: BoardTaskAssignee): string => {
  const key = assignee.id || assignee.email || "";
  if (!key) return AVATAR_PALETTE[0];
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
};

/* -------------------------------------------------------------------------- */
/*                                 Task card                                  */
/* -------------------------------------------------------------------------- */

/**
 * Drag-handle props produced by `useSortable` from `@dnd-kit/sortable` and
 * forwarded by {@link import("./sortable-task-card").SortableBoardTaskCard}
 * so the inner `<button>` becomes the activator for the drag gesture (with
 * a small pointer-distance threshold, so a quick click still opens the task
 * detail modal). The shape is `HTMLAttributes` plus an optional `ref` because
 * dnd-kit's `setActivatorNodeRef` is what wires the activator into its
 * internal accessibility tree.
 */
export type BoardTaskDragHandleProps = HTMLAttributes<HTMLButtonElement> & {
  ref?: Ref<HTMLButtonElement>;
};

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
  /**
   * Force the card into a non-interactive surface regardless of whether
   * `onSelect` is supplied. Mirrors the read-only mode the kanban surface
   * uses for non-members and locked-down boards: the click handler is
   * ignored, the focus ring + cursor-pointer affordance fall away, and the
   * card renders as a plain {@link Card} so nothing reads as actionable.
   *
   * Note: `onSelect` being undefined already produces a non-interactive
   * card (the DragOverlay clone path uses this). `readOnly` is the explicit
   * counterpart — useful when the parent always wires a handler but wants
   * to disable activation in a particular context (e.g. a preview / archive
   * surface where opening the detail modal isn't meaningful).
   */
  readOnly?: boolean;
  /**
   * Drag-handle props from `useSortable`. When provided AND the card is in
   * its interactive mode (`onSelect` set, `readOnly` false), the inner
   * `<button>` doubles as the drag activator. We keep this off the non-
   * interactive path on purpose — skeleton / read-only cards shouldn't
   * accidentally start a drag.
   */
  dragHandleProps?: BoardTaskDragHandleProps;
  /**
   * Visual hint that this card's row is currently being dragged. The card
   * stays mounted (so dnd-kit can measure layout for the placeholder slot)
   * but renders as a translucent silhouette while a `DragOverlay` clone is
   * shown at the cursor instead.
   */
  isDragging?: boolean;
  /** Optional inline style passthrough (used for the drag overlay clone). */
  style?: CSSProperties;
};

/**
 * Single task on the board.
 *
 *   - Title is the primary affordance — clamped to two lines so a runaway
 *     title can't blow up the lane height.
 *   - Description (if present) renders as a one-line preview, also clamped.
 *   - Assignee, if present, renders as a small avatar with initials inside
 *     a deterministically-coloured circle (so the same person reads as the
 *     same colour everywhere on the board). The avatar carries the full
 *     name/email as a `title` tooltip and an `aria-label` so a hover or
 *     screen reader still surfaces the full identity.
 *   - Attachment count, if known and > 0, renders as a small paperclip
 *     badge to the left of the assignee. Hidden when the count is zero or
 *     when the field isn't supplied (the bulk board endpoint doesn't yet
 *     surface attachment counts; the badge will start appearing the moment
 *     it does, with no further wiring required here).
 *
 * Interaction:
 *   - When `onSelect` is provided AND `readOnly` is false the entire card
 *     is a `<button>` (Enter/Space activation, focus ring, etc. are all
 *     platform-native), and clicking/keyboard-activating the card hands the
 *     task back to the parent — typically to open the task-detail modal.
 *   - When `onSelect` is omitted OR `readOnly` is true the card stays a
 *     plain, non-interactive surface — used by the skeleton path, the drag
 *     overlay clone, and read-only contexts where opening the detail modal
 *     isn't meaningful.
 */
export function BoardTaskCard({
  task,
  onSelect,
  readOnly = false,
  dragHandleProps,
  isDragging = false,
  style,
}: BoardTaskCardProps) {
  const interactive = !readOnly && typeof onSelect === "function";
  const cardClassName = cn(
    "block w-full space-y-2 rounded-md border bg-background p-3 text-left shadow-sm transition-colors",
    "hover:border-foreground/30 hover:shadow-md",
    interactive &&
      "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background",
    // While a drag is in progress, the source card stays mounted but reads
    // as a placeholder slot (translucent + dashed border) so the layout
    // doesn't reflow as the DragOverlay clone moves with the cursor.
    isDragging && "opacity-40 border-dashed shadow-none",
  );

  // Whether to surface an attachment-count badge. We treat unknown
  // (`undefined`) and zero the same way: nothing renders. Negative values
  // are also defensively excluded — the count is a non-negative integer at
  // the source of truth, but a stale serialiser could in theory produce a
  // bogus value and we'd rather omit the badge than render "-1".
  const attachmentCount = task.attachmentCount;
  const showAttachmentBadge =
    typeof attachmentCount === "number" && attachmentCount > 0;

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

      <div className="flex items-center justify-between gap-2 pt-1">
        {/* Leading slot: attachment-count badge when > 0, otherwise an
            empty spacer so the trailing assignee block stays right-aligned
            without needing two layout branches. */}
        {showAttachmentBadge ? (
          <AttachmentBadge count={attachmentCount as number} />
        ) : (
          <span aria-hidden="true" />
        )}
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
    //
    // When `dragHandleProps` is supplied (sortable mode) we spread it onto
    // the button so it doubles as the drag activator. The PointerSensor's
    // distance constraint keeps a quick click → onSelect (open detail
    // modal) path working: a press without movement past the threshold
    // never starts a drag and the synthesized click fires normally.
    const { ref: dragRef, ...dragRest } = dragHandleProps ?? {};
    return (
      <button
        ref={dragRef}
        type="button"
        onClick={() => onSelect?.(task)}
        aria-label={`Open task: ${task.title}`}
        style={style}
        className={cn(
          "rounded-lg border bg-background text-foreground shadow-sm",
          cardClassName,
        )}
        {...dragRest}
      >
        {inner}
      </button>
    );
  }

  return (
    <Card className={cardClassName} style={style}>
      {inner}
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/*                            Assignee avatar                                 */
/* -------------------------------------------------------------------------- */

function AssigneeAvatar({ assignee }: { assignee: BoardTaskAssignee }) {
  const label = assignee.name ?? assignee.email;
  const initials = initialsFromAssignee(assignee);
  const colorClass = colorClassForAssignee(assignee);

  return (
    <Avatar
      // Smaller than the default 9×9 used in the members table — the card is
      // dense and a 9×9 avatar would dominate the metadata row.
      className="h-6 w-6"
      title={label}
      aria-label={`Assigned to ${label}`}
    >
      <AvatarFallback className={cn("text-[10px] font-semibold", colorClass)}>
        {initials}
      </AvatarFallback>
    </Avatar>
  );
}

/* -------------------------------------------------------------------------- */
/*                          Attachment count badge                            */
/* -------------------------------------------------------------------------- */

/**
 * Compact "N attachments" pill rendered on the leading edge of the card's
 * metadata row. The paperclip icon is the universal attachment glyph (it
 * mirrors the icon used in the task-detail modal's Attachments section),
 * paired with the numeric count so a glance both flags "this card has
 * files" and tells you how many.
 *
 * Plural-aware aria-label: "1 attachment" vs "N attachments". The visible
 * pill stays terse so it doesn't crowd the assignee avatar on a narrow
 * lane, but screen readers still get the full phrase.
 */
function AttachmentBadge({ count }: { count: number }) {
  const label = count === 1 ? "1 attachment" : `${count} attachments`;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border bg-muted/60 px-2 py-0.5",
        "text-[11px] font-medium text-muted-foreground",
      )}
      aria-label={label}
      title={label}
    >
      <Paperclip className="h-3 w-3" aria-hidden="true" />
      <span>{count}</span>
    </span>
  );
}
