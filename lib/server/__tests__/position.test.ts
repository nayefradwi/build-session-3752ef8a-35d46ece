/**
 * Unit tests for the position-management helpers in
 * `lib/server/position.ts`. These cover the contract the four position-
 * mutating endpoints (task create, column create, task move, column
 * reorder) rely on:
 *
 *   - `getNewPosition(items, insertAfterIndex)` — index-based insertion
 *     that returns POSITION_STEP-spaced positions on append/prepend and
 *     integer midpoints on mid-insert.
 *   - `recalculatePositions(items)` — full re-stamp to the canonical
 *     0, 1000, 2000... spacing, preserving every other field on each
 *     input row.
 *
 * Run with:
 *   npm test
 * which expands to a `tsx --test ...` invocation including this file.
 *
 * No vitest / jest dependency — uses Node's built-in test runner
 * (`node:test`) with strict assertions (`node:assert/strict`).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  POSITION_STEP,
  getNewPosition,
  recalculatePositions,
} from "../position";

describe("getNewPosition", () => {
  it("returns 0 for an empty list regardless of insertAfterIndex", () => {
    assert.equal(getNewPosition([], -1), 0);
    assert.equal(getNewPosition([], 0), 0);
    assert.equal(getNewPosition([], 5), 0);
  });

  it("appends after the last item with POSITION_STEP spacing", () => {
    const items = [{ position: 0 }, { position: 1000 }, { position: 2000 }];
    assert.equal(getNewPosition(items, items.length - 1), 3000);
  });

  it("clamps an out-of-range insertAfterIndex to the end", () => {
    const items = [{ position: 0 }, { position: 1000 }];
    // Anything >= length-1 lands at the end.
    assert.equal(getNewPosition(items, 99), 2000);
  });

  it("prepends before the first item with POSITION_STEP spacing", () => {
    const items = [{ position: 1000 }, { position: 2000 }];
    // -1 is the canonical "insert at the start" sentinel.
    assert.equal(getNewPosition(items, -1), 0);
  });

  it("returns a negative position when prepending before position 0", () => {
    // The helper does not clamp the floor — caller is expected to
    // recalculate when the column drifts negative.
    const items = [{ position: 0 }];
    assert.equal(getNewPosition(items, -1), -POSITION_STEP);
  });

  it("returns the integer midpoint for a mid-insert", () => {
    const items = [{ position: 0 }, { position: 1000 }, { position: 2000 }];
    // After items[0] => midpoint(0, 1000) = 500.
    assert.equal(getNewPosition(items, 0), 500);
    // After items[1] => midpoint(1000, 2000) = 1500.
    assert.equal(getNewPosition(items, 1), 1500);
  });

  it("floors the midpoint when neighbors sum to an odd number", () => {
    const items = [{ position: 0 }, { position: 3 }];
    // floor((0 + 3) / 2) = 1
    assert.equal(getNewPosition(items, 0), 1);
  });

  it("collapses onto the lower neighbor when no integer gap remains", () => {
    // Adjacent neighbors with gap 1: floor((4 + 5) / 2) = 4 — equal to
    // the lower neighbor. The route layer is responsible for detecting
    // this collision and falling back to recalculatePositions.
    const items = [{ position: 4 }, { position: 5 }];
    assert.equal(getNewPosition(items, 0), 4);
  });

  it("treats a single-item list as both endpoints when appropriate", () => {
    const items = [{ position: 5000 }];
    // Append after the only item.
    assert.equal(getNewPosition(items, 0), 6000);
    // Prepend before the only item.
    assert.equal(getNewPosition(items, -1), 4000);
  });

  it("preserves arbitrary extra fields by reading only `position`", () => {
    // The generic constraint only requires `{position: number}`, but the
    // helper must work on richer rows passed from Drizzle selects.
    const items = [
      { id: "a", title: "first", position: 0 },
      { id: "b", title: "second", position: 1000 },
    ];
    assert.equal(getNewPosition(items, 1), 2000);
  });
});

describe("recalculatePositions", () => {
  it("stamps 0, 1000, 2000... in input order", () => {
    const items = [
      { id: "a", position: 17 },
      { id: "b", position: 42 },
      { id: "c", position: 99 },
    ];
    const result = recalculatePositions(items);
    assert.deepEqual(result, [
      { id: "a", position: 0 },
      { id: "b", position: 1000 },
      { id: "c", position: 2000 },
    ]);
  });

  it("returns an empty array for an empty input", () => {
    assert.deepEqual(recalculatePositions([]), []);
  });

  it("preserves every non-position field on each row", () => {
    const items = [
      { id: "a", title: "alpha", columnId: "x", position: 7 },
      { id: "b", title: "bravo", columnId: "x", position: 13 },
    ];
    const result = recalculatePositions(items);
    assert.deepEqual(result, [
      { id: "a", title: "alpha", columnId: "x", position: 0 },
      { id: "b", title: "bravo", columnId: "x", position: 1000 },
    ]);
  });

  it("does not mutate the input array or its rows", () => {
    const items = [
      { id: "a", position: 17 },
      { id: "b", position: 42 },
    ];
    const snapshot = items.map((row) => ({ ...row }));
    const result = recalculatePositions(items);
    // Inputs untouched.
    assert.deepEqual(items, snapshot);
    // And the helper returned a fresh array, not the same reference.
    assert.notEqual(result, items);
    assert.notEqual(result[0], items[0]);
  });

  it("does not sort — input order defines new position order", () => {
    // Rows passed in reverse "logical" order get reverse positions.
    const items = [
      { id: "z", position: 0 },
      { id: "a", position: 1000 },
    ];
    const result = recalculatePositions(items);
    assert.deepEqual(result, [
      { id: "z", position: 0 },
      { id: "a", position: 1000 },
    ]);
  });

  it("uses POSITION_STEP as the stride", () => {
    // Defensive against accidental future tweaks to the constant.
    const items = [{ position: 0 }, { position: 0 }, { position: 0 }];
    const result = recalculatePositions(items);
    assert.equal(result[0].position, 0);
    assert.equal(result[1].position, POSITION_STEP);
    assert.equal(result[2].position, 2 * POSITION_STEP);
  });
});
