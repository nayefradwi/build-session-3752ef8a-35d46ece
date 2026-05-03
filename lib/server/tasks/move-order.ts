/**
 * Pure splice + re-stamp computation that backs PATCH
 * /api/tasks/[taskId]/move.
 *
 * The route handler is responsible for:
 *   - Authentication, authorization, and tenant gating.
 *   - Acquiring `SELECT ... FOR UPDATE` locks on the source and (when
 *     distinct) target column rows in canonical id order.
 *   - Reading the *non-moving* tasks in the target column ordered by
 *     `(position ASC, id ASC)` and passing them to {@link computeMoveOrder}.
 *   - Persisting the resulting positions, only writing rows whose position
 *     actually changed.
 *
 * Pulling this slice out as a pure function buys us two things:
 *   1. Determinism — same inputs always produce the same outputs, with no
 *      hidden DB / clock / random dependencies. That makes it trivially
 *      unit-testable, and we use the unit tests to lock in the same-column
 *      reorder semantics asked for by task 630d942e.
 *   2. A single source of truth for the splice math. The route handler can't
 *      drift from the test fixtures because both consume the same function.
 *
 * The function is intentionally *unaware* of cross-column vs. same-column —
 * the route encodes that distinction by what it passes in for `existing`:
 *
 *   - Cross-column move: `existing` = every task currently in the *target*
 *     column (the moving task is not in this column yet, so naturally
 *     absent). Any source-column compaction is the route's responsibility.
 *   - Same-column reorder: `existing` = every task in the column EXCEPT the
 *     moving task. Splicing the moving task back in at the clamped index
 *     produces the post-move ordering for the entire column.
 *
 * The clamp keeps drag-and-drop UIs forgiving: a client passing
 * `newPosition` outside `[0, existing.length]` lands the moving task at the
 * nearest end rather than 400-failing on an off-by-one drop index.
 */

export interface MoveOrderInputTask {
  /** Stable task id; used as deterministic tiebreaker upstream. */
  id: string;
  /**
   * Current position in the target column. `null` means "no position yet"
   * — currently unused, but kept so the route can pass the raw row shape
   * without massaging it.
   */
  position: number | null;
}

export interface MoveOrderEntry {
  /** Task id (the moving task or one of the existing siblings). */
  id: string;
  /** Position before the move; `null` for the moving task. */
  oldPosition: number | null;
  /** Final 0-based position after the move. */
  newPosition: number;
  /** True for the single moving task; false for shifted siblings. */
  isMoving: boolean;
}

export interface ComputeMoveOrderArgs {
  /**
   * Tasks currently in the target column EXCLUDING the moving task,
   * pre-sorted by `(position ASC, id ASC)`.
   */
  existing: ReadonlyArray<MoveOrderInputTask>;
  /** Id of the task being moved into / within the target column. */
  movingTaskId: string;
  /**
   * Caller's requested 0-based slot. Out-of-range values are clamped to
   * `[0, existing.length]` rather than rejected.
   */
  newPosition: number;
}

export interface ComputeMoveOrderResult {
  /**
   * Final ordering of every task in the target column after the move,
   * with each entry's resulting `newPosition` already populated.
   */
  order: ReadonlyArray<MoveOrderEntry>;
  /** The clamped insert index actually used to splice the moving task. */
  insertIndex: number;
}

/**
 * Splice the moving task into `existing` at a clamped insert index, then
 * stamp positions 0..N. Pure — does not touch the database.
 *
 * @example Same-column reorder, move id=B from position 1 to position 3
 *   in column [A=0, B=1, C=2, D=3]:
 *
 *     existing       = [A@0, C@2, D@3]   // B excluded
 *     newPosition    = 3
 *     insertIndex    = clamp(3, 0..3)    = 3
 *     order          = [A@0, C@1, D@2, B@3]
 *
 * @example Same-column reorder, move id=B from position 1 to position 0:
 *
 *     existing       = [A@0, C@2, D@3]
 *     newPosition    = 0
 *     insertIndex    = 0
 *     order          = [B@0, A@1, C@2, D@3]
 */
export function computeMoveOrder({
  existing,
  movingTaskId,
  newPosition,
}: ComputeMoveOrderArgs): ComputeMoveOrderResult {
  const insertIndex = Math.min(
    Math.max(Math.floor(newPosition), 0),
    existing.length,
  );

  const order: MoveOrderEntry[] = [];
  for (let i = 0; i < insertIndex; i++) {
    const row = existing[i];
    order.push({
      id: row.id,
      oldPosition: row.position,
      newPosition: i,
      isMoving: false,
    });
  }
  // Sentinel oldPosition = null on the moving task so callers know to
  // always issue an UPDATE — its columnId may also be flipping, which a
  // raw position diff alone wouldn't catch.
  order.push({
    id: movingTaskId,
    oldPosition: null,
    newPosition: insertIndex,
    isMoving: true,
  });
  for (let i = insertIndex; i < existing.length; i++) {
    const row = existing[i];
    order.push({
      id: row.id,
      oldPosition: row.position,
      newPosition: i + 1,
      isMoving: false,
    });
  }

  return { order, insertIndex };
}
