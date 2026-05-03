"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { CSSProperties } from "react";

import { BoardColumn } from "@/components/board/board-column";
import type { BoardColumnData, BoardTask } from "@/components/board/types";

/* -------------------------------------------------------------------------- */
/*                          Sortable column wrapper                           */
/* -------------------------------------------------------------------------- */

type SortableBoardColumnProps = {
  column: BoardColumnData;
  /**
   * When true, this column registers as a sortable item and the header
   * grip button activates the column-reorder gesture. Mirrors the team-
   * admin gate enforced server-side by
   * `PATCH /api/projects/[projectId]/columns/reorder`; non-admins still
   * see the column rendered identically (minus the grip handle), so the
   * column reads exactly the same on read-only board surfaces.
   */
  canReorderColumns?: boolean;
  /**
   * Forwarded straight through to `BoardColumn` — the existing per-task
   * drag-and-drop UI is unaffected by column reordering. We split these
   * out as named props (rather than `...rest`) so the prop contract stays
   * explicit and TypeScript can check each callsite.
   */
  canAddTask?: boolean;
  onRequestAddTask?: () => void;
  onSelectTask?: (task: BoardTask) => void;
  canReorder?: boolean;
  canEditName?: boolean;
  projectId?: string;
  onRenamed?: (column: {
    id: string;
    projectId: string;
    name: string;
    position: number;
  }) => void;
  /**
   * When true, the column header renders a hover-revealed delete button
   * gated by an AlertDialog confirmation. Mirrors the team-admin gate
   * enforced by `DELETE /api/projects/[projectId]/columns/[columnId]` —
   * forwarded straight through to {@link BoardColumn} without any
   * sortable-specific wiring.
   */
  canDelete?: boolean;
  /**
   * When true, the delete button is rendered but disabled. Driven from the
   * parent's column count: a project must always have at least one column,
   * so the affordance is grayed out when only one lane remains. The server
   * still enforces the same invariant (422 LAST_COLUMN), but the disabled
   * affordance keeps the admin from even attempting a guaranteed-fail
   * round-trip.
   */
  disableDelete?: boolean;
  /**
   * Splice-on-success callback for a confirmed column delete. Forwarded
   * straight to {@link BoardColumn}; the parent uses it to drop the column
   * from local board state without a full refetch.
   */
  onDeleted?: (columnId: string) => void;
};

/**
 * Drag-source + drop-target wrapper for a single kanban column.
 *
 *   - `useSortable` registers the column as both a sortable item (so the
 *     surrounding horizontal `SortableContext` can compute drop indices) and
 *     a drop target (other columns can be dragged onto it for reorder). The
 *     activator node ref is forwarded to the column's grip-handle button so
 *     the rest of the column header (title click → inline rename, "+ Add
 *     task" trigger, task cards within) keeps working without competing for
 *     the same press gesture.
 *   - `transform`/`transition` are applied to the wrapping `<div>` so the
 *     column animates between sort positions without re-mounting (which
 *     would tear down its task-level `SortableContext` and forfeit drag
 *     state). The wrapper is `shrink-0` so the column row's horizontal
 *     scroll behavior is preserved.
 *   - When `canReorderColumns` is false, the wrapper is a passthrough: no
 *     sortable registration, no drag handle, no transform — non-admins get
 *     the original chrome-free column. We still render the same wrapper
 *     element so the React tree shape is consistent across membership
 *     levels (avoids a remount when a member is promoted to admin
 *     mid-session).
 *   - `data` carries a typed payload the parent's `onDragEnd` consumes:
 *       { type: "column-sortable", columnId } — the suffix distinguishes
 *       this from the existing per-column droppable (id `col-${id}`,
 *       data.type "column") which is used for *task* drops onto an empty
 *       lane. Keeping the two types disjoint means a single `DndContext`
 *       can host both gestures without ambiguous over-resolution.
 */
export function SortableBoardColumn({
  column,
  canReorderColumns = false,
  canAddTask,
  onRequestAddTask,
  onSelectTask,
  canReorder,
  canEditName,
  projectId,
  onRenamed,
  canDelete,
  disableDelete,
  onDeleted,
}: SortableBoardColumnProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: column.id,
    data: { type: "column-sortable", columnId: column.id },
    disabled: !canReorderColumns,
  });

  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style} className="shrink-0">
      <BoardColumn
        column={column}
        canAddTask={canAddTask}
        onRequestAddTask={onRequestAddTask}
        onSelectTask={onSelectTask}
        canReorder={canReorder}
        canEditName={canEditName}
        projectId={projectId}
        onRenamed={onRenamed}
        isDragging={isDragging}
        canDelete={canDelete}
        disableDelete={disableDelete}
        onDeleted={onDeleted}
        dragHandleProps={
          canReorderColumns
            ? {
                ref: setActivatorNodeRef,
                ...attributes,
                ...listeners,
              }
            : undefined
        }
      />
    </div>
  );
}
