"use client";

import { Layers, Plus } from "lucide-react";

import { cn } from "@/lib/client/utils";
import { BoardTaskCard } from "@/components/board/board-task-card";
import type { BoardColumnData, BoardTask } from "@/components/board/types";

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
}: BoardColumnProps) {
  const taskCount = column.tasks.length;

  return (
    <section
      aria-label={`${column.name} column, ${taskCount} ${
        taskCount === 1 ? "task" : "tasks"
      }`}
      className="flex w-64 shrink-0 flex-col gap-3 rounded-lg border bg-muted/40 p-3 md:w-72 lg:w-80"
    >
      <header className="flex items-center justify-between gap-2 px-1">
        <h2 className="truncate text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {column.name}
        </h2>
        <span
          className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-background px-1.5 text-xs font-medium text-muted-foreground"
          aria-hidden="true"
        >
          {taskCount}
        </span>
      </header>

      <ol className="flex flex-col gap-2" role="list">
        {column.tasks.length === 0 ? (
          <ColumnEmptyState />
        ) : (
          column.tasks.map((task) => (
            <li key={task.id}>
              <BoardTaskCard task={task} onSelect={onSelectTask} />
            </li>
          ))
        )}
      </ol>

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
