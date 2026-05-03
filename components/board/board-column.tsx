"use client";

import { Layers } from "lucide-react";

import { BoardTaskCard } from "@/components/board/board-task-card";
import type { BoardColumnData } from "@/components/board/types";

/* -------------------------------------------------------------------------- */
/*                                   Column                                   */
/* -------------------------------------------------------------------------- */

type BoardColumnProps = {
  column: BoardColumnData;
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
export function BoardColumn({ column }: BoardColumnProps) {
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
              <BoardTaskCard task={task} />
            </li>
          ))
        )}
      </ol>
    </section>
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
