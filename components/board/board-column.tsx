"use client";

import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  GripVertical,
  Layers,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import type { HTMLAttributes, Ref } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { ApiError, apiClient } from "@/lib/client/api-client";
import { cn } from "@/lib/client/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { BoardTaskCard } from "@/components/board/board-task-card";
import { SortableBoardTaskCard } from "@/components/board/sortable-task-card";
import type { BoardColumnData, BoardTask } from "@/components/board/types";

/* -------------------------------------------------------------------------- */
/*                            Column drag handle props                        */
/* -------------------------------------------------------------------------- */

/**
 * Drag-handle props produced by `useSortable` from `@dnd-kit/sortable` and
 * forwarded by {@link import("./sortable-board-column").SortableBoardColumn}
 * so the column header's grip button becomes the activator for the column-
 * reorder gesture. The shape mirrors the task-card variant: `HTMLAttributes`
 * plus an optional `ref` because dnd-kit's `setActivatorNodeRef` is what wires
 * the activator into its internal accessibility tree. We attach the activator
 * to a dedicated grip button (rather than the entire column header) so the
 * existing inline-rename click affordance on the header keeps working without
 * a press conflict.
 */
export type BoardColumnDragHandleProps = HTMLAttributes<HTMLButtonElement> & {
  ref?: Ref<HTMLButtonElement>;
};

/* -------------------------------------------------------------------------- */
/*                                   Column                                   */
/* -------------------------------------------------------------------------- */

type BoardColumnProps = {
  column: BoardColumnData;
  /**
   * When true, the column renders an "+ Add task" affordance pinned at the
   * bottom of the lane. Gated to team members only — non-members would 403
   * on submit, so the affordance is hidden to keep the read-only experience
   * clean. Defaults to false so the existing skeleton-only callsite stays
   * unaffected.
   */
  canAddTask?: boolean;
  /**
   * Click handler for the "+ Add task" affordance. The parent owns the
   * dialog state (single mounted instance shared across columns), so the
   * column just signals "open the dialog targeting me".
   */
  onRequestAddTask?: () => void;
  /**
   * Click handler for an individual task card. Routed up to the board so it
   * can open the shared task-detail modal targeting the selected task.
   */
  onSelectTask?: (task: BoardTask) => void;
  /**
   * When true, task cards in this column are draggable (and the column
   * itself is a drop target). Mirrors the team-member gate on `canAddTask`
   * — non-members would 403 the move endpoint, so we disable the gesture
   * client-side rather than queuing a guaranteed-fail PATCH.
   */
  canReorder?: boolean;
  /**
   * When true, the column header becomes interactive: clicking it swaps the
   * `<h2>` for an inline `<input>` so the admin can rename the column. On
   * blur/Enter the new name is PUT to
   * `/api/projects/[projectId]/columns/[columnId]`. Mirrors the server-side
   * team-admin gate; tenant admins do NOT bypass (the endpoint enforces the
   * same rule), so we only flip this on for team admins.
   */
  canEditName?: boolean;
  /**
   * Project id used to build the rename PUT path. Required when
   * `canEditName` is true; the column itself only knows its own id +
   * projectId-on-the-row, but we forward the projectId from the parent
   * (rather than relying on `column.projectId`) for symmetry with the rest
   * of the board's mutation callsites.
   */
  projectId?: string;
  /**
   * Splice-on-success callback for an inline rename. The PUT handler returns
   * the updated column row; we forward the relevant fields so the parent can
   * update its local board state without a full refetch.
   */
  onRenamed?: (column: {
    id: string;
    projectId: string;
    name: string;
    position: number;
  }) => void;
  /**
   * When provided, the column header renders a drag-handle (`GripVertical`)
   * button wired up as the dnd-kit activator for column reordering. We keep
   * the activator on a dedicated grip — rather than the whole column or the
   * column title — so the existing inline-rename click handler on the title
   * doesn't fight the press-and-drag gesture. Forwarded by
   * {@link import("./sortable-board-column").SortableBoardColumn}; absent
   * for non-admin callers, who never see a drag affordance.
   */
  dragHandleProps?: BoardColumnDragHandleProps;
  /**
   * Visual hint that this column is currently being dragged. The source
   * column stays mounted (so dnd-kit can measure the placeholder slot), but
   * fades to a translucent silhouette while a `DragOverlay` clone follows
   * the cursor.
   */
  isDragging?: boolean;
  /**
   * When true, renders a hover-revealed trash icon in the column header
   * that opens an AlertDialog confirming deletion. Mirrors the server-side
   * team-admin gate enforced by
   * `DELETE /api/projects/[projectId]/columns/[columnId]`. Tenant admins do
   * NOT bypass; column management is team-scoped, just like rename and
   * reorder. Hidden entirely for non-admins so the read-only column header
   * stays chrome-free.
   */
  canDelete?: boolean;
  /**
   * When true, the delete button is disabled (rendered but not clickable).
   * Used by the parent to enforce the "you can't delete the only column"
   * UX guard — the server enforces the same invariant via a 422 LAST_COLUMN
   * response, but disabling the button up front means the admin can't even
   * try, which is friendlier than a confirm-then-toast cycle.
   */
  disableDelete?: boolean;
  /**
   * Splice-on-success callback for a confirmed delete. Fired with the
   * deleted column's id once the DELETE round-trips successfully (or 404s
   * — a 404 means a peer admin already deleted the same column, which we
   * treat as success so the local board state catches up). The parent uses
   * this to drop the column from `columns` without a full refetch.
   */
  onDeleted?: (columnId: string) => void;
};

/**
 * Single kanban lane.
 *
 *   - The lane's width is fixed-ish (responsive bumps): wide enough to hold a
 *     readable card on desktop without dwarfing the row, narrow enough that
 *     three lanes fit on a tablet ≥768px (~256–288px).
 *   - `shrink-0` keeps the lane from collapsing when the parent flex row
 *     overflows — it should always overflow into a horizontal scroll rather
 *     than squish lanes.
 *   - Header shows the column name + a small task count badge so an at-a-
 *     glance "how loaded is this lane" read is one eye-flick away.
 */
export function BoardColumn({
  column,
  canAddTask = false,
  onRequestAddTask,
  onSelectTask,
  canReorder = false,
  canEditName = false,
  projectId,
  onRenamed,
  dragHandleProps,
  isDragging = false,
  canDelete = false,
  disableDelete = false,
  onDeleted,
}: BoardColumnProps) {
  const taskCount = column.tasks.length;

  // Memoize the sortable item ids — `SortableContext` re-registers items on
  // every prop identity change, and the parent re-renders the column tree
  // whenever any unrelated piece of board state shifts.
  const taskIds = useMemo(() => column.tasks.map((t) => t.id), [column.tasks]);

  // Register the lane as a drop target. Tasks themselves are sortable items
  // (and therefore implicit drop targets) so within a populated lane the
  // task-level collisions drive the drop-index math; this column-level
  // droppable is what lets a card land on an EMPTY lane (no sortable items
  // to collide with) and on the trailing whitespace below the last card.
  const {
    setNodeRef: setColumnDropRef,
    isOver: columnIsOver,
    active: columnActive,
  } = useDroppable({
    id: `col-${column.id}`,
    data: { type: "column", columnId: column.id },
    disabled: !canReorder,
  });

  // Highlight the lane only when a drag is in progress AND we're hovering
  // it. `isOver` covers the empty-lane / below-tasks case; we also pulse
  // the lane chrome whenever any drag is active and the active item lives
  // in a *different* column, so the user has a clear "this is a valid
  // drop zone" affordance even before the cursor reaches the column.
  const activeFromOtherColumn =
    columnActive?.data?.current &&
    (columnActive.data.current as { type?: string; columnId?: string }).type ===
      "task" &&
    (columnActive.data.current as { columnId?: string }).columnId !== column.id;

  return (
    <section
      ref={canReorder ? setColumnDropRef : undefined}
      aria-label={`${column.name} column, ${taskCount} ${
        taskCount === 1 ? "task" : "tasks"
      }`}
      className={cn(
        // `group/column` lets descendants opt into "appears on column hover"
        // affordances (the delete trash icon, in particular) without
        // bleeding hover state from sibling columns. Keyboard users can
        // reach the same affordance via tab focus — `focus-within` keeps the
        // button visible while it (or any nested control) is focused.
        "group/column",
        "flex w-64 shrink-0 flex-col gap-3 rounded-lg border bg-muted/40 p-3 md:w-72 lg:w-80",
        "transition-colors",
        canReorder && activeFromOtherColumn && "border-primary/40 bg-muted/70",
        canReorder &&
          columnIsOver &&
          "border-primary bg-primary/5 ring-2 ring-primary/40 ring-offset-2 ring-offset-background",
        // Source-column placeholder while a column drag is in flight. We
        // keep the lane mounted so sibling columns can compute their slide-
        // aside transforms, but render it faded + dashed so the user reads
        // it as a drop slot rather than the live column.
        isDragging && "border-dashed opacity-40",
      )}
    >
      <header className="flex items-center justify-between gap-2 px-1">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {dragHandleProps ? (
            <ColumnDragHandle
              dragHandleProps={dragHandleProps}
              columnName={column.name}
            />
          ) : null}
          <ColumnHeaderTitle
            column={column}
            canEditName={canEditName && Boolean(projectId)}
            projectId={projectId}
            onRenamed={onRenamed}
          />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span
            className="inline-flex h-5 min-w-[1.25rem] shrink-0 items-center justify-center rounded-full bg-background px-1.5 text-xs font-medium text-muted-foreground"
            aria-hidden="true"
          >
            {taskCount}
          </span>
          {canDelete && projectId ? (
            <ColumnDeleteAffordance
              column={column}
              projectId={projectId}
              taskCount={taskCount}
              disabled={disableDelete}
              onDeleted={onDeleted}
            />
          ) : null}
        </div>
      </header>

      <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
        <ol className="flex min-h-[2.5rem] flex-col gap-2" role="list">
          {column.tasks.length === 0 ? (
            <ColumnEmptyState />
          ) : (
            column.tasks.map((task) =>
              canReorder ? (
                <SortableBoardTaskCard
                  key={task.id}
                  task={task}
                  onSelect={onSelectTask}
                />
              ) : (
                <li key={task.id} className="list-none">
                  <BoardTaskCard task={task} onSelect={onSelectTask} />
                </li>
              ),
            )
          )}
        </ol>
      </SortableContext>

      {canAddTask && onRequestAddTask ? (
        <AddTaskTrigger
          onClick={onRequestAddTask}
          columnName={column.name}
        />
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*                            Column drag handle                              */
/* -------------------------------------------------------------------------- */

/**
 * Grip-icon button that doubles as the dnd-kit activator for column
 * reordering. Sits flush against the column title so it's discoverable
 * without competing with the title's hover affordances:
 *
 *   - The grip is always visible to admins (low-contrast by default, full
 *     opacity on hover/focus). Unlike the rename pencil it shouldn't be
 *     hidden behind a hover, because the only useful interaction is the
 *     drag itself — a fully-hidden grip on a touch device would have no
 *     activation path.
 *   - We render a real `<button>` rather than a div so keyboard focus +
 *     `aria-label` come for free; the parent supplies dnd-kit's
 *     `setActivatorNodeRef` via `dragHandleProps.ref` so the activator is
 *     wired into the accessibility tree without us re-implementing focus
 *     management.
 *   - `cursor-grab` (and `active:cursor-grabbing` while pressed) telegraphs
 *     that the element is the drag handle, mirroring task-card behavior.
 *   - `onClick` is a no-op but we still attach `type="button"` so the
 *     button never accidentally submits a parent form.
 */
function ColumnDragHandle({
  dragHandleProps,
  columnName,
}: {
  dragHandleProps: BoardColumnDragHandleProps;
  columnName: string;
}) {
  const { ref, ...rest } = dragHandleProps;
  return (
    <button
      ref={ref}
      type="button"
      aria-label={`Reorder ${columnName} column`}
      // Touch-action none keeps mobile browsers from interpreting the press
      // as a horizontal scroll gesture before the dnd-kit pointer sensor
      // gets a chance to activate; without it, dragging the column on a
      // touch device fights the page's overflow-x-auto scroll.
      style={{ touchAction: "none" }}
      className={cn(
        "flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/60",
        "cursor-grab transition-colors hover:bg-background/60 hover:text-foreground active:cursor-grabbing",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
      )}
      {...rest}
    >
      <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/*                          Column header / inline rename                     */
/* -------------------------------------------------------------------------- */

type ColumnRenameResponse = {
  column: {
    id: string;
    projectId: string;
    name: string;
    position: number;
  };
};

/**
 * Column-header title with inline rename for team admins.
 *
 *   - Read mode: a static `<h2>` styled identically to the previous static
 *     header, but wrapped in a button-like trigger when `canEditName` is true.
 *     A subtle pencil icon appears on hover (and on keyboard focus) as the
 *     "click to edit" affordance — invisible by default so non-admins (and
 *     idle admins) get the original chrome-free look.
 *   - Edit mode: swaps the title for an `<input>` pre-populated with the
 *     current name, autofocused + text-selected so an admin can immediately
 *     type a replacement or chip away at the existing label.
 *   - Commit triggers: blur OR Enter. Whitespace-only / empty input reverts
 *     to the previous name (no PUT). Unchanged input also short-circuits the
 *     PUT — we only round-trip when the trimmed value differs from the
 *     current name.
 *   - Cancel trigger: Escape reverts and exits edit mode without a save.
 *   - During the in-flight PUT the input is disabled and read-only-styled so
 *     a fast double-Enter doesn't fire a duplicate request.
 *   - On any error (404 / 403 / 5xx / network) we revert the optimistic
 *     local state and surface the message via sonner. The parent stays on
 *     the truth-of-the-server `column.name` until the parent's `onRenamed`
 *     callback succeeds.
 */
function ColumnHeaderTitle({
  column,
  canEditName,
  projectId,
  onRenamed,
}: {
  column: BoardColumnData;
  canEditName: boolean;
  projectId: string | undefined;
  onRenamed?: (column: {
    id: string;
    projectId: string;
    name: string;
    position: number;
  }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(column.name);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Guard so blur-after-Enter doesn't double-submit. `commit()` already
  // short-circuits on `submitting`, but Enter immediately blurs the input
  // (we call `.blur()` on the keydown handler) which would otherwise re-enter
  // the commit path with stale local state.
  const committedRef = useRef(false);

  // Re-sync the draft when the column's authoritative name shifts under us
  // (sibling admin landed a rename, full board refetch, etc.) AND we're not
  // currently mid-edit. Editing locally always wins until the user commits
  // or cancels.
  useEffect(() => {
    if (!editing) {
      setDraft(column.name);
    }
  }, [column.name, editing]);

  // Autofocus + select-all when entering edit mode so the admin can either
  // type a full replacement or arrow-key into the existing label without an
  // extra click.
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const beginEdit = () => {
    if (!canEditName || submitting) return;
    committedRef.current = false;
    setDraft(column.name);
    setEditing(true);
  };

  const cancelEdit = () => {
    committedRef.current = true;
    setDraft(column.name);
    setEditing(false);
  };

  const commit = async () => {
    if (committedRef.current) return;
    committedRef.current = true;

    const trimmed = draft.trim();

    // Empty / whitespace-only: revert to the previous name without firing a
    // PUT. The server would reject it as INVALID_INPUT anyway, and the spec
    // calls out this exact behavior ("revert to previous name if empty").
    if (trimmed.length === 0) {
      setDraft(column.name);
      setEditing(false);
      return;
    }

    // No change: short-circuit so we don't churn the database for a
    // round-trip that produces the same row back.
    if (trimmed === column.name) {
      setDraft(column.name);
      setEditing(false);
      return;
    }

    if (!projectId) {
      // Defensive: parent should not enable rename without a projectId, but
      // if it slips through we fall back to a clean revert rather than a
      // broken PUT path.
      setDraft(column.name);
      setEditing(false);
      return;
    }

    setSubmitting(true);
    try {
      const response = await apiClient.put<ColumnRenameResponse>(
        `/api/projects/${projectId}/columns/${column.id}`,
        { name: trimmed },
        { silent: true, skipAuthRedirect: false },
      );
      // Forward the server's authoritative row to the parent so its column
      // map updates in lockstep. Local draft also re-syncs via the
      // column.name effect once the parent's state lands.
      onRenamed?.(response.column);
      setEditing(false);
    } catch (err) {
      const description =
        err instanceof ApiError
          ? err.message
          : "We couldn't rename that column. Please try again.";
      toast.error("Couldn't rename column", { description });
      // Roll back the draft to the last-known authoritative name so the
      // admin sees the pre-edit state, then drop out of edit mode. (Staying
      // in edit mode after a 403/404 would just funnel the same error.)
      setDraft(column.name);
      setEditing(false);
    } finally {
      setSubmitting(false);
    }
  };

  if (editing) {
    return (
      <label className="min-w-0 flex-1">
        <span className="sr-only">Rename {column.name} column</span>
        <input
          ref={inputRef}
          type="text"
          value={draft}
          maxLength={120}
          disabled={submitting}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            void commit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              // Blur drives the actual commit (which avoids double-firing
              // because `committedRef` is checked at the top of `commit`).
              // Fall through to commit directly here too in case some host
              // browser swallows the blur event.
              e.currentTarget.blur();
              if (!committedRef.current) {
                void commit();
              }
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelEdit();
            }
          }}
          aria-label={`Rename ${column.name} column`}
          className={cn(
            "h-7 w-full rounded-md border border-input bg-background px-2 text-sm font-semibold uppercase tracking-wide text-foreground",
            "ring-offset-background placeholder:text-muted-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            "disabled:cursor-not-allowed disabled:opacity-60",
          )}
        />
      </label>
    );
  }

  if (!canEditName) {
    return (
      <h2 className="min-w-0 flex-1 truncate text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {column.name}
      </h2>
    );
  }

  return (
    <button
      type="button"
      onClick={beginEdit}
      aria-label={`Rename ${column.name} column`}
      className={cn(
        "group/rename flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left",
        "-mx-1 px-1 py-0.5",
        "transition-colors hover:bg-background/60",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
      )}
    >
      <h2 className="min-w-0 flex-1 truncate text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {column.name}
      </h2>
      {/* Subtle pencil affordance — invisible by default so the chrome-free
          look is preserved, fades in on hover/focus to telegraph editability
          without competing with the column name. `aria-hidden` because the
          button itself is already labelled. */}
      <Pencil
        className={cn(
          "h-3 w-3 shrink-0 text-muted-foreground/70",
          "opacity-0 transition-opacity",
          "group-hover/rename:opacity-100 group-focus-visible/rename:opacity-100",
        )}
        aria-hidden="true"
      />
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/*                          Column delete affordance                          */
/* -------------------------------------------------------------------------- */

/**
 * Structured 422 body the column DELETE handler returns when a product
 * invariant blocks the request. We pull these off the thrown
 * {@link ApiError}'s `data` so we can surface contextual messaging instead of
 * the generic toast — the server's `message` is already human-readable but
 * the discriminator (`error`) lets us pluralize / theme per case.
 *
 *   - `LAST_COLUMN`: returned when the project would be left with zero
 *     columns. We pre-empt this UX with `disableDelete` (driven from the
 *     parent's column-count), but the server is authoritative — a peer
 *     admin's racing delete could land between renders, so we still handle
 *     the 422 cleanly.
 *   - `COLUMN_HAS_TASKS`: returned when the column still has at least one
 *     task. The body inlines `taskCount` so we can pluralize the toast
 *     ("column has 3 tasks") without a follow-up GET.
 */
type ColumnDeleteErrorBody =
  | { error: "LAST_COLUMN"; message?: string }
  | { error: "COLUMN_HAS_TASKS"; message?: string; taskCount?: number };

function isColumnDeleteErrorBody(
  data: unknown,
): data is ColumnDeleteErrorBody {
  if (!data || typeof data !== "object") return false;
  const maybe = data as { error?: unknown };
  return maybe.error === "LAST_COLUMN" || maybe.error === "COLUMN_HAS_TASKS";
}

/**
 * Hover-revealed trash button + confirm-and-delete AlertDialog for a single
 * kanban column.
 *
 * Hover reveal:
 *   - The button is rendered at full size but `opacity-0` by default. The
 *     parent `<section>` carries a `group/column` class so the button fades
 *     in only when the user hovers / focuses *this* column. Keyboard users
 *     reach it via tab order — `group-focus-within` keeps it visible while
 *     focused, and the AlertDialog opens on Enter/Space like any button.
 *   - Touch devices have no hover, so we also reveal the button when the
 *     `aria-expanded` flips on (open state) — though in practice a tap on
 *     mobile triggers the focus state too, so the button is reachable.
 *
 * Confirm flow:
 *   - Clicking the trash button opens an AlertDialog warning that any tasks
 *     in the column must be moved first. We don't block the open on
 *     `taskCount > 0` client-side because the server's structured 422
 *     remains authoritative (a peer could have moved/created tasks between
 *     renders), and the warning copy is the same either way.
 *   - The Action button stays mounted while the DELETE is in flight; we
 *     `event.preventDefault()` Radix's default close-on-action so we can
 *     keep the dialog open through the round-trip and reflect errors
 *     in-place rather than stranding the user with a toast on a bare board.
 *
 * Error mapping:
 *   - 422 LAST_COLUMN → "Couldn't delete column" toast with the server's
 *     message. The button is also disabled when `disableDelete` is true, so
 *     hitting this branch normally means a peer admin's delete raced ahead.
 *   - 422 COLUMN_HAS_TASKS → toast with "Cannot delete: column has N task(s)"
 *     so the admin gets a clear nudge to move tasks first. We prefer the
 *     server's `taskCount` over the local `column.tasks.length` because the
 *     local count may be stale (a peer member could have just created a
 *     task between fetches).
 *   - 404 → treat as success: the column is already gone. We forward the
 *     id so the parent can prune local state and stop showing a stale lane.
 *   - Any other status / network error → generic "Couldn't delete column"
 *     toast with the parsed message.
 */
function ColumnDeleteAffordance({
  column,
  projectId,
  taskCount,
  disabled,
  onDeleted,
}: {
  column: BoardColumnData;
  projectId: string;
  taskCount: number;
  disabled: boolean;
  onDeleted?: (columnId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleConfirmDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await apiClient.delete(
        `/api/projects/${projectId}/columns/${column.id}`,
        { silent: true, skipAuthRedirect: false },
      );
      toast.success("Column deleted", {
        description: `“${column.name}” has been removed.`,
      });
      onDeleted?.(column.id);
      setOpen(false);
    } catch (err) {
      if (err instanceof ApiError) {
        // Structured 422 invariants from the column DELETE handler. We
        // pull the discriminator off `err.data` so the toast can carry
        // task-blocking copy distinct from last-column copy. `err.message`
        // has already been populated from the server's `message` field by
        // the api-client's extractor, but we fall back defensively in
        // case a future server change drops the `message` key.
        if (err.status === 422 && isColumnDeleteErrorBody(err.data)) {
          if (err.data.error === "COLUMN_HAS_TASKS") {
            const blocked = err.data.taskCount ?? taskCount;
            const description =
              err.data.message ??
              `Cannot delete: column has ${blocked} ${
                blocked === 1 ? "task" : "tasks"
              }. Move them first.`;
            toast.error("Couldn't delete column", { description });
          } else {
            // LAST_COLUMN. The button should already be disabled when this
            // is the only column, so this branch normally only fires when a
            // peer admin's racing delete has emptied the project under us.
            const description =
              err.data.message ??
              "A project must always have at least one column.";
            toast.error("Couldn't delete column", { description });
          }
          // Keep the AlertDialog open so the admin sees the cause without
          // losing context — they can Cancel out (or move tasks first and
          // retry without re-opening the trigger).
          return;
        }
        if (err.status === 404) {
          // Already gone. Treat as a successful no-op so the local board
          // catches up. A peer admin likely deleted the same column.
          toast.success("Column deleted", {
            description: "This column was already removed.",
          });
          onDeleted?.(column.id);
          setOpen(false);
          return;
        }
        toast.error("Couldn't delete column", { description: err.message });
      } else {
        toast.error("Couldn't delete column", {
          description: "Something went wrong. Please try again.",
        });
      }
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (disabled || deleting) return;
          setOpen(true);
        }}
        disabled={disabled || deleting}
        aria-label={
          disabled
            ? `Delete ${column.name} column (disabled — last column)`
            : `Delete ${column.name} column`
        }
        title={
          disabled
            ? "A project must have at least one column"
            : `Delete ${column.name}`
        }
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground/70",
          "transition-opacity",
          // Hidden by default; revealed on column hover or when any control
          // inside the column receives focus. Always visible while the
          // confirm dialog is open so the trigger doesn't disappear under
          // the user's cursor.
          "opacity-0 group-hover/column:opacity-100 group-focus-within/column:opacity-100",
          open && "opacity-100",
          "hover:bg-destructive/10 hover:text-destructive",
          "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
          "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground/70",
        )}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          // Block dismissal while the DELETE is in flight so the user can't
          // navigate away mid-call and miss the toast outcome.
          if (deleting && !next) return;
          setOpen(next);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this column?</AlertDialogTitle>
            <AlertDialogDescription>
              “{column.name}” will be permanently removed. Tasks must be moved
              first if any exist. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={cn(buttonVariants({ variant: "destructive" }))}
              disabled={deleting}
              onClick={(event) => {
                // Prevent Radix's default close-on-action so we can keep the
                // dialog open across the network round-trip and surface
                // 422-class errors in-place. Without this, a slow DELETE
                // would drop the user back onto the board with only a
                // toast for feedback.
                event.preventDefault();
                void handleConfirmDelete();
              }}
            >
              {deleting ? (
                <>
                  <Loader2
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                  Deleting…
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  Delete column
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Add task trigger                              */
/* -------------------------------------------------------------------------- */

/**
 * "+ Add task" affordance pinned at the bottom of the column. Visually
 * subdued (dashed border, muted background) so it doesn't compete with the
 * real task cards above it, but full-width and a single click target so it
 * reads as the natural next step on an empty or short lane.
 */
function AddTaskTrigger({
  onClick,
  columnName,
}: {
  onClick: () => void;
  columnName: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Add task to ${columnName}`}
      className={cn(
        "flex w-full items-center justify-center gap-1.5",
        "rounded-md border border-dashed bg-background/40 px-3 py-2 text-xs font-medium text-muted-foreground",
        "transition-colors hover:border-foreground/40 hover:bg-background/80 hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background",
      )}
    >
      <Plus className="h-3.5 w-3.5" aria-hidden="true" />
      <span>Add task</span>
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/*                          Column empty / skeleton                           */
/* -------------------------------------------------------------------------- */

function ColumnEmptyState() {
  return (
    <li
      className="flex flex-col items-center gap-1 rounded-md border border-dashed bg-background/60 px-3 py-6 text-center"
      role="status"
    >
      <Layers
        className="h-4 w-4 text-muted-foreground"
        aria-hidden="true"
      />
      <p className="text-xs text-muted-foreground">No tasks yet</p>
    </li>
  );
}

/**
 * Static visual replica of a column for use inside a `DragOverlay` clone.
 *
 * Why a separate component: `BoardColumn` registers a `useDroppable` for the
 * empty-lane drop target and renders a `SortableContext` for its tasks.
 * Mounting that tree inside `DragOverlay` would re-register the same
 * `col-${id}` droppable, triggering dnd-kit's "duplicate id" warning and
 * confusing collision detection. The overlay only needs the visual frame
 * (header + count + a non-interactive list of cards), so we render a thin
 * static replica with no dnd-kit hooks. The result follows the cursor while
 * the source column stays mounted in-place as a translucent placeholder.
 */
export function BoardColumnOverlay({ column }: { column: BoardColumnData }) {
  const taskCount = column.tasks.length;
  return (
    <section
      aria-hidden="true"
      className="flex w-64 shrink-0 flex-col gap-3 rounded-lg border bg-background p-3 shadow-2xl md:w-72 lg:w-80"
    >
      <header className="flex items-center justify-between gap-2 px-1">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/70">
            <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {column.name}
          </h2>
        </div>
        <span className="inline-flex h-5 min-w-[1.25rem] shrink-0 items-center justify-center rounded-full bg-background px-1.5 text-xs font-medium text-muted-foreground">
          {taskCount}
        </span>
      </header>
      <ol className="flex min-h-[2.5rem] flex-col gap-2" role="list">
        {column.tasks.length === 0 ? (
          <li
            className="flex flex-col items-center gap-1 rounded-md border border-dashed bg-background/60 px-3 py-6 text-center"
            role="status"
          >
            <Layers
              className="h-4 w-4 text-muted-foreground"
              aria-hidden="true"
            />
            <p className="text-xs text-muted-foreground">No tasks yet</p>
          </li>
        ) : (
          column.tasks.map((task) => (
            <li key={task.id} className="list-none">
              <BoardTaskCard task={task} />
            </li>
          ))
        )}
      </ol>
    </section>
  );
}

/**
 * Loading-state placeholder lane. Two card-shaped skeletons keep the row's
 * vertical rhythm stable so the post-load reflow doesn't jump the page.
 */
export function BoardColumnSkeleton() {
  return (
    <div
      className="flex w-64 shrink-0 flex-col gap-3 rounded-lg border bg-muted/40 p-3 md:w-72 lg:w-80"
      aria-hidden="true"
    >
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="h-4 w-24 animate-pulse rounded-md bg-muted" />
        <div className="h-5 w-6 animate-pulse rounded-full bg-muted" />
      </div>
      <div className="flex flex-col gap-2">
        <div className="h-20 animate-pulse rounded-md bg-background/80" />
        <div className="h-16 animate-pulse rounded-md bg-background/80" />
      </div>
    </div>
  );
}
