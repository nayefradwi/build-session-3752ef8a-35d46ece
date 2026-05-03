/**
 * Unit tests for {@link computeMoveOrder} — the pure splice + re-stamp
 * computation that backs PATCH /api/tasks/[taskId]/move.
 *
 * The primary intent (per task 630d942e) is to lock in **same-column
 * reorder** semantics: when the route excludes the moving task from the
 * `existing` set, splicing it back at the requested index must (a) keep
 * the column contiguous 0..N-1, (b) only shift the sibling rows that
 * actually need to move, and (c) clamp out-of-range indices rather than
 * 400-fail.
 *
 * Run with:
 *   npm test
 * which expands to
 *   tsx --test lib/server/tasks/__tests__/move-order.test.ts
 *
 * No vitest / jest dependency — uses Node's built-in test runner
 * (`node:test`) with strict assertions (`node:assert/strict`), driven
 * through `tsx` so the TypeScript file runs without a separate compile.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeMoveOrder } from "../move-order";

/**
 * Fixture helper for cross-column moves: build the `existing` argument
 * with contiguous positions 0..N-1 — the moving task is in a *different*
 * column, so the target column has no gap.
 */
const buildContiguousExisting = (
  ids: ReadonlyArray<string>,
): Array<{ id: string; position: number }> =>
  ids.map((id, position) => ({ id, position }));

/**
 * Fixture helper for **same-column reorder**: simulate the gap left by
 * excluding the moving task from a column whose tasks were originally
 * stamped contiguous 0..N-1. `originalIds` is the full pre-move column
 * (in position order); `movingId` is the id we omit. The resulting
 * `existing` list keeps the original positions, so callers see a gap
 * where the moving task used to sit (e.g. excluding B from
 * [A=0, B=1, C=2, D=3] yields [A@0, C@2, D@3]).
 *
 * This matches what the route actually sees, since
 * `SELECT ... WHERE id <> $movingId ORDER BY position` does not renumber
 * the surviving rows.
 */
const buildSameColumnExisting = (
  originalIds: ReadonlyArray<string>,
  movingId: string,
): Array<{ id: string; position: number }> =>
  originalIds
    .map((id, position) => ({ id, position }))
    .filter((row) => row.id !== movingId);

/**
 * Pull just the resulting (id, position) pairs out of the helper's output
 * for compact equality assertions.
 */
const ordering = (
  result: ReturnType<typeof computeMoveOrder>,
): Array<[string, number]> =>
  result.order.map((row) => [row.id, row.newPosition]);

describe("computeMoveOrder — same-column reorder", () => {
  it("moves a card from the middle to the end (B: 1 -> 3)", () => {
    // Column [A=0, B=1, C=2, D=3]; moving B to last slot. The existing
    // set sees the gap left by B (A@0, C@2, D@3).
    const existing = buildSameColumnExisting(["A", "B", "C", "D"], "B");
    const result = computeMoveOrder({
      existing,
      movingTaskId: "B",
      newPosition: 3,
    });

    assert.equal(result.insertIndex, 3);
    assert.deepEqual(ordering(result), [
      ["A", 0],
      ["C", 1],
      ["D", 2],
      ["B", 3],
    ]);
    // Only siblings whose position actually changed should be re-stamped.
    // A stayed at 0 (no-op); C shifted 2->1, D shifted 3->2; B is moving.
    const writes = result.order.filter(
      (row) => row.isMoving || row.oldPosition !== row.newPosition,
    );
    assert.deepEqual(
      writes.map((row) => row.id),
      ["C", "D", "B"],
    );
  });

  it("moves a card from the middle to the start (B: 1 -> 0)", () => {
    const existing = buildSameColumnExisting(["A", "B", "C", "D"], "B");
    const result = computeMoveOrder({
      existing,
      movingTaskId: "B",
      newPosition: 0,
    });

    assert.equal(result.insertIndex, 0);
    assert.deepEqual(ordering(result), [
      ["B", 0],
      ["A", 1],
      ["C", 2],
      ["D", 3],
    ]);
    const writes = result.order.filter(
      (row) => row.isMoving || row.oldPosition !== row.newPosition,
    );
    // B is moving; A had to shift 0 -> 1; C stayed at 2 (gap closed it
    // from 2 to 2 — no-op), D stayed at 3.
    assert.deepEqual(
      writes.map((row) => row.id),
      ["B", "A"],
    );
  });

  it("moves a card from the end to the start (D: 3 -> 0)", () => {
    const existing = buildSameColumnExisting(["A", "B", "C", "D"], "D");
    const result = computeMoveOrder({
      existing,
      movingTaskId: "D",
      newPosition: 0,
    });

    assert.deepEqual(ordering(result), [
      ["D", 0],
      ["A", 1],
      ["B", 2],
      ["C", 3],
    ]);
  });

  it("is a no-op when the requested slot is the same as the original", () => {
    // Column [A=0, B=1, C=2, D=3]; moving B back to position 1.
    const existing = buildSameColumnExisting(["A", "B", "C", "D"], "B");
    const result = computeMoveOrder({
      existing,
      movingTaskId: "B",
      newPosition: 1,
    });

    assert.equal(result.insertIndex, 1);
    assert.deepEqual(ordering(result), [
      ["A", 0],
      ["B", 1],
      ["C", 2],
      ["D", 3],
    ]);
    // No siblings should need writes — A stayed at 0, C at 2, D at 3.
    const siblingWrites = result.order.filter(
      (row) => !row.isMoving && row.oldPosition !== row.newPosition,
    );
    assert.deepEqual(siblingWrites, []);
  });

  it("clamps an over-large newPosition to the last valid slot", () => {
    // existing.length is 3; passing 99 must clamp to 3 (insert at end).
    const existing = buildSameColumnExisting(["A", "B", "C", "D"], "B");
    const result = computeMoveOrder({
      existing,
      movingTaskId: "B",
      newPosition: 99,
    });

    assert.equal(result.insertIndex, 3);
    assert.deepEqual(ordering(result), [
      ["A", 0],
      ["C", 1],
      ["D", 2],
      ["B", 3],
    ]);
  });

  it("clamps a negative newPosition to 0 (insert at start)", () => {
    const existing = buildSameColumnExisting(["A", "B", "C", "D"], "B");
    const result = computeMoveOrder({
      existing,
      movingTaskId: "B",
      newPosition: -42,
    });

    assert.equal(result.insertIndex, 0);
    assert.deepEqual(ordering(result), [
      ["B", 0],
      ["A", 1],
      ["C", 2],
      ["D", 3],
    ]);
  });

  it("floors a fractional newPosition before clamping", () => {
    const existing = buildSameColumnExisting(["A", "B", "C", "D"], "B");
    const result = computeMoveOrder({
      existing,
      movingTaskId: "B",
      newPosition: 2.9,
    });

    assert.equal(result.insertIndex, 2);
    assert.deepEqual(ordering(result), [
      ["A", 0],
      ["C", 1],
      ["B", 2],
      ["D", 3],
    ]);
  });

  it("handles a single-task column reordering to itself", () => {
    // Column with just B; existing is empty after exclusion.
    const result = computeMoveOrder({
      existing: [],
      movingTaskId: "B",
      newPosition: 0,
    });

    assert.equal(result.insertIndex, 0);
    assert.deepEqual(ordering(result), [["B", 0]]);
  });

  it("always issues an UPDATE for the moving task (sentinel oldPosition)", () => {
    // Even when the post-move position equals the slot a sibling sat in,
    // the moving entry must be flagged as needing a write — the route
    // may also be flipping its columnId.
    const existing = buildSameColumnExisting(["A", "B", "C", "D"], "B");
    const result = computeMoveOrder({
      existing,
      movingTaskId: "B",
      newPosition: 2,
    });

    const movingRow = result.order.find((row) => row.id === "B");
    assert.ok(movingRow, "moving task must appear in the resulting order");
    assert.equal(movingRow!.isMoving, true);
    assert.equal(movingRow!.oldPosition, null);
    assert.equal(movingRow!.newPosition, 2);
  });
});

describe("computeMoveOrder — cross-column move semantics", () => {
  it("inserts into an empty target column", () => {
    // Cross-column move: the target column has zero tasks and the moving
    // task isn't in `existing` (it lives in another column upstream).
    const result = computeMoveOrder({
      existing: [],
      movingTaskId: "X",
      newPosition: 0,
    });

    assert.equal(result.insertIndex, 0);
    assert.deepEqual(ordering(result), [["X", 0]]);
  });

  it("appends to a populated target column when newPosition is past the end", () => {
    // Target column had A=0, B=1; moving X arrives, requested at slot 5.
    const existing = buildContiguousExisting(["A", "B"]);
    const result = computeMoveOrder({
      existing,
      movingTaskId: "X",
      newPosition: 5,
    });

    assert.equal(result.insertIndex, 2);
    assert.deepEqual(ordering(result), [
      ["A", 0],
      ["B", 1],
      ["X", 2],
    ]);
  });

  it("splices into the middle of a populated target column", () => {
    // Target column had A=0, B=1, C=2; moving X requested at slot 1.
    const existing = buildContiguousExisting(["A", "B", "C"]);
    const result = computeMoveOrder({
      existing,
      movingTaskId: "X",
      newPosition: 1,
    });

    assert.deepEqual(ordering(result), [
      ["A", 0],
      ["X", 1],
      ["B", 2],
      ["C", 3],
    ]);
  });
});
