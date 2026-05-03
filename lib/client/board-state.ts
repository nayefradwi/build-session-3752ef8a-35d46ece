/**
 * Pure helpers backing the kanban board's optimistic drag-and-drop UI.
 *
 * These functions never touch React or the DOM — they take a snapshot of the
 * board's columns + a desired drop target and return the next snapshot. The
 * `KanbanBoard` component owns the React state; this module owns the splice
 * math so it can be exercised by `node:test` fixtures without spinning up
 * jsdom.
 *
 * The same-column reorder semantics (task 49e97171) are intentionally
 * symmetric with the cross-column move (task 4681e41e):
 *
 *   1. Pull the moving task out of its source lane (whichever lane that is).
 *   2. Insert it into the target lane at the clamped index — `[0, length]`
 *      after the strip — which mirrors the server's clamp inside
 *      {@link import("@/lib/server/tasks/move-order").computeMoveOrder}.
 *   3. Re-stamp `position` to a contiguous `0..N-1` range in every touched
 *      lane so sibling cards reflect their post-move slot. The server does
 *      the same compaction; computing it here keeps the optimistic UI in
 *      sync with whatever the PATCH echoes back, and means a successful
 *      PATCH triggers (at most) a single re-render of the affected card,
 *      not a board-wide reflow.
 *
 * For same-column reorder specifically, this collapses to:
 *   - `existing` = column tasks with the moving task filtered out
 *   - splice in at the clamped index
 *   - re-stamp 0..N-1
 * which is bit-for-bit equivalent to dnd-kit's classic
 * `arrayMove(items, oldIndex, newIndex)` and matches the server's response
 * row-for-row.
 */

import type { BoardColumnData, BoardTask } from "@/components/board/types";

/**
 * Splice helper: produce a new `columns` array with the given task relocated
 * to `targetColumnId` at index `newPosition`. Same-column and cross-column
 * moves both flow through this single path — the only difference is whether
 * the source and target column ids match.
 *
 * Returns `null` if the task can't be located in the snapshot (defensive — a
 * stale callsite shouldn't crash, just no-op).
 *
 * The returned array is a brand-new top-level reference, with brand-new
 * column references for any column whose task list changed. Lanes whose
 * task list is byte-for-byte identical to the input are returned by
 * reference so React can skip re-rendering them.
 *
 * @example Same-column reorder, move A from index 0 to index 2 in
 *   column [A, B, C]:
 *
 *     applyOptimisticMove(columns, "A", colId, 2)
 *       -> column tasks = [B@0, C@1, A@2]
 *
 * @example Cross-column move, drag A from col1 to position 1 of col2 [X, Y, Z]:
 *
 *     applyOptimisticMove(columns, "A", "col2", 1)
 *       -> col1 tasks = [...without A, re-stamped]
 *          col2 tasks = [X@0, A@1, Y@2, Z@3]
 */
export function applyOptimisticMove(
  columns: BoardColumnData[],
  taskId: string,
  targetColumnId: string,
  newPosition: number,
): BoardColumnData[] | null {
  let movingTask: BoardTask | null = null;

  // Phase 1: strip the moving task from whichever lane currently owns it.
  // We touch every column even though only one will match — the per-column
  // identity check keeps the spread allocation off the hot path for the
  // 99% case (board with one source column and many idle siblings).
  const stripped = columns.map((col) => {
    const idx = col.tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) return col;
    movingTask = col.tasks[idx];
    return {
      ...col,
      tasks: col.tasks.filter((t) => t.id !== taskId),
    };
  });

  if (!movingTask) return null;
  const moving: BoardTask = movingTask;

  // Phase 2: insert into the target lane (which may be the source lane —
  // same-column reorder is the natural case where source.id === target.id),
  // and re-stamp positions on the source lane so the gap left behind closes
  // contiguously. Idle lanes pass through unchanged by reference so React
  // can skip their re-render — `map`'s default returns-a-new-array behavior
  // would otherwise force every column to re-render on every drop.
  const next = stripped.map((col) => {
    if (col.id !== targetColumnId) {
      // Re-stamp source / sibling tasks only if something would actually
      // change. `Array.prototype.map` always returns a new array, so we
      // walk first to check whether any row's position needs to shift,
      // and short-circuit to the original column reference when none do.
      let changed = false;
      for (let i = 0; i < col.tasks.length; i++) {
        if (col.tasks[i].position !== i) {
          changed = true;
          break;
        }
      }
      if (!changed) return col;
      const tasks = col.tasks.map((t, i) =>
        t.position === i ? t : { ...t, position: i },
      );
      return { ...col, tasks };
    }
    const insertIdx = Math.min(
      Math.max(Math.floor(newPosition), 0),
      col.tasks.length,
    );
    const inserted: BoardTask = {
      ...moving,
      columnId: targetColumnId,
      position: insertIdx,
    };
    const merged = [
      ...col.tasks.slice(0, insertIdx),
      inserted,
      ...col.tasks.slice(insertIdx),
    ].map((t, i) => (t.position === i ? t : { ...t, position: i }));
    return { ...col, tasks: merged };
  });

  return next;
}

/**
 * Resolve the drop index a same-column reorder should request from the
 * server, given the snapshot lane and the over-task the user dropped on.
 *
 * dnd-kit's `closestCorners` collision detection returns the sibling whose
 * corners are closest to the active card's corners. With
 * `verticalListSortingStrategy`, that resolves to a literal `BoardTask` id
 * within the same lane during a same-column drag. The desired post-move
 * index is exactly the over-task's index in the *snapshot* (pre-strip)
 * lane — equivalent to dnd-kit's canonical
 * `arrayMove(items, oldIndex, newIndex)` semantics.
 *
 * Returns `-1` if the over-task can't be found in the lane (defensive — a
 * stale callsite shouldn't crash, just bail out of the drop).
 */
export function resolveSameColumnDropIndex(
  laneTasks: ReadonlyArray<BoardTask>,
  overTaskId: string,
): number {
  return laneTasks.findIndex((t) => t.id === overTaskId);
}

/**
 * Detect a no-op same-column drop: the user picked up a card and released
 * it back in its original slot. Skipping the round-trip keeps a stray
 * click-and-release from churning the database / the user's history of
 * "moves".
 */
export function isSameColumnNoop(
  sourceColumn: BoardColumnData,
  targetColumnId: string,
  taskId: string,
  newPosition: number,
): boolean {
  if (sourceColumn.id !== targetColumnId) return false;
  const oldIndex = sourceColumn.tasks.findIndex((t) => t.id === taskId);
  return oldIndex === newPosition;
}
