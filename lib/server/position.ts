/**
 * Integer-based position management for ordered collections (kanban
 * columns within a project, tasks within a column).
 *
 * The scheme is the standard "sparse integer order key" pattern: assign
 * positions in multiples of {@link POSITION_STEP} (0, 1000, 2000, ...)
 * so a mid-insert can pick the integer midpoint between two neighbors
 * without renumbering any existing rows. After ~log2(POSITION_STEP)
 * mid-inserts the gap shrinks to zero — at that point the caller falls
 * back to {@link recalculatePositions} to re-stamp the entire ordered
 * set back to the canonical 0/1000/2000 spacing.
 *
 * Two pure helpers are exported. They are deliberately database-agnostic
 * so they are unit-testable without a Postgres dependency, and so they
 * can be wired identically into both the column endpoints (which DO
 * have a `(projectId, position)` unique index) and the task endpoints
 * (which do NOT — the schema explicitly tolerates transient ties).
 *
 * Used by:
 *   - POST   /api/projects/[projectId]/tasks            (append task)
 *   - POST   /api/projects/[projectId]/columns          (append column)
 *   - PATCH  /api/projects/[projectId]/columns/reorder  (full re-stamp)
 *   - PATCH  /api/tasks/[taskId]/move                   (splice + re-stamp)
 */

/**
 * Stride between adjacent positions when normalized.
 *
 * 1000 is the widely-used default in the sparse-key literature: every
 * mid-insert halves the available gap, so log2(1000) ≈ 10 mid-inserts
 * fit between two adjacent normalized neighbors before the gap
 * collapses and a recalculation is required. Tighter spacings save
 * almost nothing on disk (positions are 32-bit ints either way) and
 * cost real headroom; wider spacings burn the int range without buying
 * additional UX.
 */
export const POSITION_STEP = 1000;

/**
 * Minimum shape required by the helpers: a numeric `position`. All
 * other fields on `T` (id, columnId, name, ...) are preserved by
 * {@link recalculatePositions}.
 */
export interface Positioned {
  position: number;
}

/**
 * Compute a new integer position for inserting an item AFTER
 * `items[insertAfterIndex]`. `items` MUST be pre-sorted by ascending
 * `position` — the helper does not sort defensively because callers
 * already pull the list ORDER BY position from Postgres.
 *
 * Index semantics:
 *   - `insertAfterIndex < 0`           → insert at the start (before
 *                                        items[0]); returns
 *                                        items[0].position - POSITION_STEP.
 *   - `insertAfterIndex >= length - 1` → insert at the end (after the
 *                                        last item); returns
 *                                        items[last].position + POSITION_STEP.
 *   - otherwise                        → splice between `items[i]` and
 *                                        `items[i+1]`; returns the
 *                                        integer midpoint.
 *
 * Empty list bootstraps at 0 regardless of `insertAfterIndex`. This
 * keeps the "first ever item in a column" path single-line at the call
 * site instead of demanding the caller special-case it.
 *
 * Out-of-range indices are clamped to the end (not rejected), matching
 * the route-level convention for drag-and-drop UIs that occasionally
 * compute drop indices that are off-by-one at the boundary.
 *
 * Collision warning: the mid-insert path returns
 * `floor((before + after) / 2)`. When `after - before <= 1` the floor
 * collapses onto `before` and the returned position is no longer
 * strictly between its neighbors. Callers must detect this (e.g.
 * `result <= before || result >= after`) and fall back to
 * {@link recalculatePositions} on the entire column.
 *
 * @example Append to an empty column
 *   getNewPosition([], -1)  // 0
 *   getNewPosition([], 0)   // 0  (length-0 short-circuit)
 *
 * @example Append to a populated column
 *   getNewPosition([{position: 0}, {position: 1000}], 1)  // 2000
 *
 * @example Prepend to a populated column
 *   getNewPosition([{position: 1000}], -1)  // 0  (1000 - 1000)
 *
 * @example Mid-insert
 *   getNewPosition([{position: 0}, {position: 1000}], 0)  // 500
 */
export function getNewPosition<T extends Positioned>(
  items: ReadonlyArray<T>,
  insertAfterIndex: number,
): number {
  const n = items.length;
  if (n === 0) return 0;

  if (insertAfterIndex < 0) {
    return items[0].position - POSITION_STEP;
  }
  if (insertAfterIndex >= n - 1) {
    return items[n - 1].position + POSITION_STEP;
  }

  const before = items[insertAfterIndex].position;
  const after = items[insertAfterIndex + 1].position;
  return Math.floor((before + after) / 2);
}

/**
 * Re-stamp every item to the canonical 0, 1000, 2000... spacing in
 * input order. Returns a new array — the input is not mutated.
 *
 * The function does NOT sort. Callers already pull rows ORDER BY
 * position (or arrange them in the desired final order via a splice
 * step like {@link computeMoveOrder}); re-sorting here would silently
 * undo any caller-side reorder semantics.
 *
 * Use this:
 *   - After a {@link getNewPosition} mid-insert that returned a
 *     collision-prone value (no integer gap left between neighbors).
 *   - When applying a full-column reorder where the client supplied a
 *     fresh ordering (PATCH /columns/reorder, PATCH /tasks/.../move).
 *
 * @example
 *   recalculatePositions([{id: "a", position: 17}, {id: "b", position: 42}])
 *   // [{id: "a", position: 0}, {id: "b", position: 1000}]
 */
export function recalculatePositions<T extends Positioned>(
  items: ReadonlyArray<T>,
): T[] {
  return items.map((item, index) => ({
    ...item,
    position: index * POSITION_STEP,
  })) as T[];
}
