/**
 * Shared client-side types for the kanban board.
 *
 * These mirror the API responses (`GET /api/projects/[projectId]/columns`,
 * `GET /api/projects/[projectId]/tasks`) but pre-grouped: each column carries
 * its own ordered slice of tasks so the column component can render its lane
 * without re-scanning the full task list. Keeping the shapes here (rather
 * than colocating with `kanban-board.tsx`) lets the column / card components
 * import them without a circular dep on the page-level component.
 */

/** Profile slice the tasks endpoint inlines onto each task. */
export type BoardTaskAssignee = {
  id: string;
  name: string | null;
  email: string;
};

/** A single task card on the board. */
export type BoardTask = {
  id: string;
  columnId: string;
  title: string;
  description: string | null;
  position: number;
  assignee: BoardTaskAssignee | null;
  /**
   * Number of attachments persisted against this task. Optional because the
   * board's bulk `GET /api/projects/[projectId]/tasks` endpoint does not yet
   * surface this count — when present it drives the paperclip badge on the
   * task card; when undefined the card simply omits the badge. Wiring up the
   * server-side count is a backend follow-up; the field exists here so the
   * card can render the affordance the moment the count starts arriving.
   */
  attachmentCount?: number;
};

/** A column with its tasks pre-grouped in render order. */
export type BoardColumnData = {
  id: string;
  projectId: string;
  name: string;
  position: number;
  tasks: BoardTask[];
};
