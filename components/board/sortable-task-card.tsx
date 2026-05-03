"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { CSSProperties } from "react";

import { BoardTaskCard } from "@/components/board/board-task-card";
import type { BoardTask } from "@/components/board/types";

/* -------------------------------------------------------------------------- */
/*                          Sortable task-card wrapper                        */
/* -------------------------------------------------------------------------- */

type SortableBoardTaskCardProps = {
  task: BoardTask;
  /** Click → open task detail modal (forwarded to the inner card). */
  onSelect?: (task: BoardTask) => void;
  /**
   * Whether this card may be dragged. Non-members of the project still see
   * the board read-only — they can open detail modals, but the move endpoint
   * 403s for non-members so we disable drag activation entirely on their
   * side rather than letting them queue up a guaranteed-fail PATCH.
   */
  disabled?: boolean;
};

/**
 * Drag-source + drop-target wrapper for a single task card.
 *
 *   - `useSortable` registers the card as both a sortable item (so the
 *     surrounding `SortableContext` can compute drop indices) and a drop
 *     target (other cards can be dragged onto it for reorder/move).
 *   - We forward the activator (the inner `<button>`) via
 *     `setActivatorNodeRef` so the button is what actually receives drag
 *     listeners. With a pointer-distance sensor, a click without movement
 *     still routes to `onSelect` and opens the task detail modal.
 *   - `transform`/`transition` are applied to the wrapping `<li>` so the
 *     card animates between sort positions without re-mounting.
 *   - When `isDragging` is true the source stays mounted as a translucent
 *     placeholder; a `DragOverlay` clone on the parent renders the visible
 *     card at the cursor instead.
 *   - `data` carries the typed payload other handlers consume:
 *       { type: "task", task, columnId } — the column id is included
 *       redundantly here so `onDragEnd` can resolve the source/target lane
 *       without re-walking board state.
 */
export function SortableBoardTaskCard({
  task,
  onSelect,
  disabled = false,
}: SortableBoardTaskCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: task.id,
    data: { type: "task", task, columnId: task.columnId },
    disabled,
  });

  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
  };

  return (
    <li ref={setNodeRef} style={style} className="list-none">
      <BoardTaskCard
        task={task}
        onSelect={onSelect}
        isDragging={isDragging}
        dragHandleProps={
          disabled
            ? undefined
            : {
                ref: setActivatorNodeRef,
                ...attributes,
                ...listeners,
              }
        }
      />
    </li>
  );
}
