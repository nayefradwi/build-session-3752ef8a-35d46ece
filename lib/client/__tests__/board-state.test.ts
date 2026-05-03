/**
 * Unit tests for the kanban board's optimistic drag-and-drop helpers.
 *
 * The primary intent (per task 49e97171) is to lock in **same-column
 * reorder** semantics on the client: when a user drags a card within a
 * single lane and releases, the optimistic state must (a) put the card at
 * the requested slot, (b) re-stamp sibling positions to a contiguous
 * 0..N-1 range, and (c) match what the server's PATCH /api/tasks/[taskId]/move
 * endpoint will respond with so the post-PATCH sync is a no-op.
 *
 * Run with:
 *   npm test
 * which expands to
 *   tsx --test lib/client/__tests__/board-state.test.ts ...
 *
 * No vitest / jest dependency — uses Node's built-in test runner
 * (`node:test`) with strict assertions (`node:assert/strict`), driven
 * through `tsx` so the TypeScript file runs without a separate compile.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyOptimisticMove,
  isSameColumnNoop,
  resolveSameColumnDropIndex,
} from "../board-state";
import type { BoardColumnData, BoardTask } from "@/components/board/types";

/* -------------------------------------------------------------------------- */
/*                                 Fixtures                                   */
/* -------------------------------------------------------------------------- */

/**
 * Build a minimal `BoardTask` row. Tests don't care about title /
 * description / assignee — they only assert on (id, columnId, position) —
 * so we stub the cosmetic fields to fixed values.
 */
const buildTask = (id: string, columnId: string, position: number): BoardTask => ({
  id,
  columnId,
  title: `Task ${id}`,
  description: null,
  position,
  assignee: null,
});

/**
 * Build a column whose tasks are stamped contiguous 0..N-1 in argument
 * order. Mirrors the canonical post-fetch state of the board.
 */
const buildColumn = (id: string, taskIds: ReadonlyArray<string>): BoardColumnData => ({
  id,
  projectId: "project-1",
  name: id.toUpperCase(),
  position: 0,
  tasks: taskIds.map((tid, i) => buildTask(tid, id, i)),
});

/**
 * Pull just the resulting (id, position) pairs out of a column for compact
 * equality assertions.
 */
const ordering = (col: BoardColumnData | undefined): Array<[string, number]> =>
  (col?.tasks ?? []).map((t) => [t.id, t.position]);

/* -------------------------------------------------------------------------- */
/*                       Same-column reorder semantics                        */
/* -------------------------------------------------------------------------- */

describe("applyOptimisticMove — same-column reorder", () => {
  it("moves a card from the start to the end (A: 0 -> 2)", () => {
    // Column [A, B, C] — drag A onto C. The over-task index in the
    // snapshot lane (where A is still present) is 2; this matches
    // dnd-kit's `arrayMove([A, B, C], 0, 2) = [B, C, A]`.
    const columns = [buildColumn("col1", ["A", "B", "C"])];
    const next = applyOptimisticMove(columns, "A", "col1", 2);
    assert.ok(next, "expected a non-null result");
    assert.deepEqual(ordering(next[0]), [
      ["B", 0],
      ["C", 1],
      ["A", 2],
    ]);
    // Moved task's columnId is preserved (it didn't actually leave).
    const moved = next[0].tasks.find((t) => t.id === "A");
    assert.equal(moved?.columnId, "col1");
  });

  it("moves a card from the end to the start (C: 2 -> 0)", () => {
    const columns = [buildColumn("col1", ["A", "B", "C"])];
    const next = applyOptimisticMove(columns, "C", "col1", 0);
    assert.ok(next);
    assert.deepEqual(ordering(next[0]), [
      ["C", 0],
      ["A", 1],
      ["B", 2],
    ]);
  });

  it("swaps two adjacent cards (B: 1 -> 0)", () => {
    const columns = [buildColumn("col1", ["A", "B", "C"])];
    const next = applyOptimisticMove(columns, "B", "col1", 0);
    assert.ok(next);
    assert.deepEqual(ordering(next[0]), [
      ["B", 0],
      ["A", 1],
      ["C", 2],
    ]);
  });

  it("moves a card from the middle to the end in a 4-card column (B: 1 -> 3)", () => {
    // Mirrors the server-side same-column fixture in
    // lib/server/tasks/__tests__/move-order.test.ts so the client
    // optimistic state matches the server's PATCH response row-for-row.
    const columns = [buildColumn("col1", ["A", "B", "C", "D"])];
    const next = applyOptimisticMove(columns, "B", "col1", 3);
    assert.ok(next);
    assert.deepEqual(ordering(next[0]), [
      ["A", 0],
      ["C", 1],
      ["D", 2],
      ["B", 3],
    ]);
  });

  it("clamps an out-of-range positive index to the lane's tail", () => {
    // The server clamps `newPosition` to [0, length] for forgiving DnD —
    // we mirror the behavior client-side so the optimistic state matches.
    const columns = [buildColumn("col1", ["A", "B", "C"])];
    const next = applyOptimisticMove(columns, "A", "col1", 99);
    assert.ok(next);
    assert.deepEqual(ordering(next[0]), [
      ["B", 0],
      ["C", 1],
      ["A", 2],
    ]);
  });

  it("clamps a negative index to the lane's head", () => {
    const columns = [buildColumn("col1", ["A", "B", "C"])];
    const next = applyOptimisticMove(columns, "C", "col1", -5);
    assert.ok(next);
    assert.deepEqual(ordering(next[0]), [
      ["C", 0],
      ["A", 1],
      ["B", 2],
    ]);
  });

  it("re-stamps positions to contiguous 0..N-1 even when the input is sparse", () => {
    // Pre-condition the snapshot to look like the server's pre-move row
    // shape: positions 0, 1000, 2000 (or any non-contiguous set). The
    // optimistic UI uses index-stamped positions 0..N-1 since those line
    // up with what the server's response normalizes to via the helper's
    // POSITION_STEP recalculation. Either way the sibling order is what
    // the assertion locks in.
    const columns: BoardColumnData[] = [
      {
        id: "col1",
        projectId: "project-1",
        name: "COL1",
        position: 0,
        tasks: [
          buildTask("A", "col1", 0),
          buildTask("B", "col1", 1000),
          buildTask("C", "col1", 2000),
        ],
      },
    ];
    const next = applyOptimisticMove(columns, "B", "col1", 2);
    assert.ok(next);
    assert.deepEqual(ordering(next[0]), [
      ["A", 0],
      ["C", 1],
      ["B", 2],
    ]);
  });

  it("dropping a card at its own slot is the identity (no swap)", () => {
    // The board treats this as a no-op via `isSameColumnNoop` BEFORE
    // calling the helper, but the helper itself must still produce the
    // identity ordering as a defense-in-depth guarantee.
    const columns = [buildColumn("col1", ["A", "B", "C"])];
    const next = applyOptimisticMove(columns, "B", "col1", 1);
    assert.ok(next);
    assert.deepEqual(ordering(next[0]), [
      ["A", 0],
      ["B", 1],
      ["C", 2],
    ]);
  });

  it("returns null when the moving task can't be located", () => {
    // Defensive — a stale callsite that asks to move a task that's
    // already been deleted should bail out, not crash.
    const columns = [buildColumn("col1", ["A", "B", "C"])];
    const next = applyOptimisticMove(columns, "ZZZ", "col1", 0);
    assert.equal(next, null);
  });

  it("does not mutate the input columns array", () => {
    const columns = [buildColumn("col1", ["A", "B", "C"])];
    const before = columns[0].tasks.map((t) => t.id).join(",");
    applyOptimisticMove(columns, "A", "col1", 2);
    const after = columns[0].tasks.map((t) => t.id).join(",");
    assert.equal(after, before, "input columns should be untouched");
  });

  it("returns idle lanes by reference so React can skip their re-render", () => {
    const columns = [
      buildColumn("col1", ["A", "B", "C"]),
      buildColumn("col2", ["X", "Y", "Z"]),
    ];
    const next = applyOptimisticMove(columns, "A", "col1", 2);
    assert.ok(next);
    // col2 wasn't touched — same reference.
    assert.equal(next[1], columns[1]);
    // col1 was touched — new reference (so React sees the change).
    assert.notEqual(next[0], columns[0]);
  });
});

/* -------------------------------------------------------------------------- */
/*                          Cross-column move parity                          */
/* -------------------------------------------------------------------------- */

describe("applyOptimisticMove — cross-column move parity", () => {
  it("moves a card to the head of a sibling column (A: col1@0 -> col2@0)", () => {
    const columns = [
      buildColumn("col1", ["A", "B"]),
      buildColumn("col2", ["X", "Y"]),
    ];
    const next = applyOptimisticMove(columns, "A", "col2", 0);
    assert.ok(next);
    assert.deepEqual(ordering(next[0]), [["B", 0]]);
    assert.deepEqual(ordering(next[1]), [
      ["A", 0],
      ["X", 1],
      ["Y", 2],
    ]);
    const moved = next[1].tasks.find((t) => t.id === "A");
    assert.equal(moved?.columnId, "col2");
  });

  it("compacts the source lane when crossing columns (B: col1@1 -> col2@end)", () => {
    const columns = [
      buildColumn("col1", ["A", "B", "C"]),
      buildColumn("col2", ["X"]),
    ];
    const next = applyOptimisticMove(columns, "B", "col2", 99);
    assert.ok(next);
    assert.deepEqual(ordering(next[0]), [
      ["A", 0],
      ["C", 1],
    ]);
    assert.deepEqual(ordering(next[1]), [
      ["X", 0],
      ["B", 1],
    ]);
  });

  it("flips the moving task's columnId to the target", () => {
    const columns = [
      buildColumn("col1", ["A"]),
      buildColumn("col2", []),
    ];
    const next = applyOptimisticMove(columns, "A", "col2", 0);
    assert.ok(next);
    const moved = next[1].tasks.find((t) => t.id === "A");
    assert.equal(moved?.columnId, "col2");
  });
});

/* -------------------------------------------------------------------------- */
/*                            Index resolution helper                         */
/* -------------------------------------------------------------------------- */

describe("resolveSameColumnDropIndex", () => {
  it("returns the over-task's index in the lane", () => {
    const lane = [
      buildTask("A", "col1", 0),
      buildTask("B", "col1", 1),
      buildTask("C", "col1", 2),
    ];
    assert.equal(resolveSameColumnDropIndex(lane, "A"), 0);
    assert.equal(resolveSameColumnDropIndex(lane, "B"), 1);
    assert.equal(resolveSameColumnDropIndex(lane, "C"), 2);
  });

  it("returns -1 when the over-task isn't in the lane", () => {
    const lane = [buildTask("A", "col1", 0), buildTask("B", "col1", 1)];
    assert.equal(resolveSameColumnDropIndex(lane, "ZZZ"), -1);
  });
});

/* -------------------------------------------------------------------------- */
/*                              No-op detection                               */
/* -------------------------------------------------------------------------- */

describe("isSameColumnNoop", () => {
  const lane = buildColumn("col1", ["A", "B", "C"]);

  it("flags a drop on the source's own slot as a no-op", () => {
    assert.equal(isSameColumnNoop(lane, "col1", "A", 0), true);
    assert.equal(isSameColumnNoop(lane, "col1", "B", 1), true);
    assert.equal(isSameColumnNoop(lane, "col1", "C", 2), true);
  });

  it("does not flag a real same-column reorder as a no-op", () => {
    assert.equal(isSameColumnNoop(lane, "col1", "A", 1), false);
    assert.equal(isSameColumnNoop(lane, "col1", "C", 0), false);
  });

  it("does not flag a cross-column drop as a same-column no-op", () => {
    // Even if the index happens to coincide with the source slot, a
    // cross-column drop should always persist (the columnId is changing).
    assert.equal(isSameColumnNoop(lane, "col2", "A", 0), false);
  });

  it("returns false when the task isn't in the source lane (defensive)", () => {
    assert.equal(isSameColumnNoop(lane, "col1", "ZZZ", 0), false);
  });
});
