"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  AlertCircle,
  ArrowLeft,
  KanbanSquare,
  Layers,
  Lock,
  Plus,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";

import { ApiError, apiClient } from "@/lib/client/api-client";
import { cn } from "@/lib/client/utils";
import { Button } from "@/components/ui/button";
import { BoardColumn, BoardColumnSkeleton } from "@/components/board/board-column";
import { BoardTaskCard } from "@/components/board/board-task-card";
import { AddColumnDialog } from "@/components/board/add-column-dialog";
import {
  AddTaskDialog,
  type AddTaskTeamMember,
} from "@/components/board/add-task-dialog";
import { TaskDetailModal } from "@/components/board/task-detail-modal";
import type { BoardColumnData, BoardTask } from "@/components/board/types";

/* -------------------------------------------------------------------------- */
/*                          Optimistic move helper                            */
/* -------------------------------------------------------------------------- */

/**
 * Pure splice helper: produce a new `columns` array with the given task
 * relocated to `targetColumnId` at index `newPosition`. Mirrors the server
 * algorithm in PATCH /api/tasks/[taskId]/move:
 *
 *   1. Pull the moving task out of its source lane.
 *   2. Insert it at the clamped index in the target lane (clamp matches
 *      the server: [0, length] for cross-column, [0, length] same-column
 *      after removal).
 *   3. Re-stamp positions to a contiguous 0..N-1 range in both lanes so
 *      sibling cards reflect their post-move slot. The server does the
 *      same compaction; computing it here keeps the optimistic UI in
 *      sync with whatever the server will respond.
 *
 * Returns `null` if the task can't be located in the snapshot (defensive —
 * a stale callsite shouldn't crash, just no-op).
 */
function applyOptimisticMove(
  columns: BoardColumnData[],
  taskId: string,
  targetColumnId: string,
  newPosition: number,
): BoardColumnData[] | null {
  let movingTask: BoardTask | null = null;

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

  const next = stripped.map((col) => {
    if (col.id !== targetColumnId) {
      // Source lane (or any other untouched lane): re-stamp positions so
      // the gap left behind closes contiguously, matching the server's
      // post-move compaction.
      const tasks = col.tasks.map((t, i) =>
        t.position === i ? t : { ...t, position: i },
      );
      return tasks === col.tasks ? col : { ...col, tasks };
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

/* -------------------------------------------------------------------------- */
/*                                API contracts                               */
/* -------------------------------------------------------------------------- */

/** Mirrors the response shape of `GET /api/teams/[teamId]/project`. */
type ProjectVisibility = "public" | "private";

type Project = {
  id: string;
  teamId: string;
  name: string;
  visibility: ProjectVisibility;
  createdAt: string;
};

type ProjectResponse = {
  project: Project;
  isMember: boolean;
};

/** Mirrors the response shape of `GET /api/projects/[projectId]/columns`. */
type ColumnRow = {
  id: string;
  projectId: string;
  name: string;
  position: number;
};

type ColumnsResponse = { columns: ColumnRow[] };

/** Mirrors the response shape of `GET /api/projects/[projectId]/tasks`. */
type TaskAssignee = {
  id: string;
  name: string | null;
  email: string;
};

type TaskRow = {
  id: string;
  columnId: string;
  title: string;
  description: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
  assignee: TaskAssignee | null;
};

type TasksResponse = { tasks: TaskRow[] };

/**
 * Mirrors the response shape of `GET /api/teams/[teamId]`. We pull this only
 * to determine the caller's per-team role — column management gates on team-
 * admin (not tenant-admin), and the project endpoint only tells us
 * `isMember`, not the role. One extra round trip in parallel with the project
 * fetch is cheap and keeps the admin gate accurate.
 */
type TeamRole = "admin" | "member";

type TeamMember = {
  userId: string;
  role: TeamRole;
  // The team-detail endpoint inlines a small profile slice on every member;
  // we surface it here so the assignee dropdown in the "Add task" dialog
  // can render names without an extra round-trip.
  email: string;
  name: string | null;
};

type TeamDetailResponse = {
  team: { id: string; name: string };
  members: TeamMember[];
};

/* -------------------------------------------------------------------------- */
/*                            Top-level component                             */
/* -------------------------------------------------------------------------- */

type KanbanBoardProps = {
  teamId: string;
};

/**
 * Kanban board surface for a single team's project.
 *
 *   - First fetches the team's project via `GET /api/teams/[teamId]/project`
 *     (the data model auto-seeds one project per team at team-creation, so
 *     this is the canonical "open the team's board" lookup).
 *   - Then fans out two parallel reads keyed by the resolved project id:
 *     `GET /api/projects/[projectId]/columns` and
 *     `GET /api/projects/[projectId]/tasks`. Both endpoints already filter
 *     to the owning project + apply the same tenant/visibility gate as the
 *     project endpoint, so we don't need to re-check access client-side.
 *   - Local React state holds the fully-hydrated board (columns plus an in-
 *     memory grouping of tasks-by-columnId). Keeping this in state — rather
 *     than re-deriving on every render — sets us up for future task-card
 *     mutations (drag/drop, inline edits) without a full refetch.
 *   - While any of the three requests are in flight, renders a skeleton
 *     placeholder of three columns and a few cards each so the layout
 *     doesn't reflow when data lands.
 *
 * Responsive layout:
 *   - ≥1024px (desktop): the board is a horizontal flex row. Lanes are wide
 *     (~320px) and the row scrolls horizontally if it overflows the viewport.
 *   - ≥768px (tablet): same horizontal layout but with slightly narrower
 *     lanes (~288px) so two-and-a-bit columns fit on screen and the rest
 *     scroll into view.
 *   - <768px (mobile): we keep the same horizontally-scrolling row — that's
 *     a deliberate, common kanban pattern; the spec only requires explicit
 *     responsive treatment ≥768px, but degrading to vertical-stack at this
 *     breakpoint would make the board feel completely different on mobile.
 *     Lanes shrink to ~256px to keep one fully visible.
 */
export function KanbanBoard({ teamId }: KanbanBoardProps) {
  const { data: session, status: sessionStatus } = useSession();
  const callerId = session?.user?.id ?? null;

  const [project, setProject] = useState<Project | null>(null);
  const [isMember, setIsMember] = useState(false);
  const [isTeamAdmin, setIsTeamAdmin] = useState(false);
  const [teamMembers, setTeamMembers] = useState<AddTaskTeamMember[]>([]);
  const [columns, setColumns] = useState<BoardColumnData[]>([]);
  const [addColumnOpen, setAddColumnOpen] = useState(false);
  // Column the "Add task" dialog is currently targeting. `null` when the
  // dialog is closed. Lifting this to the board (rather than per-column)
  // keeps a single dialog instance mounted at a time so opening a different
  // lane's "+ Add task" cleanly swaps the target without remounting.
  const [addTaskColumnId, setAddTaskColumnId] = useState<string | null>(null);
  // Task currently being inspected via the detail modal. Lifting to the
  // board (rather than per-card or per-column) means a single modal
  // instance handles every card on the board, and Radix can run its
  // open→close animation cleanly when swapping between cards.
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  const loadBoard = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotFound(false);
    setForbidden(false);
    try {
      // 1. Resolve the team's project. We need the projectId before we can
      //    fan out the columns + tasks reads, so this one is sequential.
      //    We fan out the team-detail fetch alongside, since it only depends
      //    on `teamId` and the response feeds the team-admin gate for the
      //    Add Column affordance.
      const [projectData, teamDetail] = await Promise.all([
        apiClient.get<ProjectResponse>(`/api/teams/${teamId}/project`, {
          silent: true,
          skipAuthRedirect: true,
        }),
        // The team-detail endpoint is tenant-gated but doesn't require
        // membership — every tenant member can read the directory — so it
        // returns a useful answer even for non-members. We tolerate failures
        // here (a 404/403 just means "no admin affordance"); the project
        // fetch above is the canonical access gate.
        apiClient
          .get<TeamDetailResponse>(`/api/teams/${teamId}`, {
            silent: true,
            skipAuthRedirect: true,
          })
          .catch(() => null),
      ]);

      // 2. Parallel fetch of columns and tasks. Both endpoints scope the
      //    response to this project, so the client-side join is purely a
      //    grouping by `columnId`.
      const [columnsData, tasksData] = await Promise.all([
        apiClient.get<ColumnsResponse>(
          `/api/projects/${projectData.project.id}/columns`,
          { silent: true, skipAuthRedirect: true },
        ),
        apiClient.get<TasksResponse>(
          `/api/projects/${projectData.project.id}/tasks`,
          { silent: true, skipAuthRedirect: true },
        ),
      ]);

      // Group tasks by columnId so each column can render its own slice
      // without re-scanning the full task list on every render. The server
      // returns tasks ordered by (columnId, position) — we preserve that
      // order by appending in iteration order.
      const tasksByColumn = new Map<string, BoardTask[]>();
      for (const task of tasksData.tasks) {
        const slice = tasksByColumn.get(task.columnId);
        const reshaped: BoardTask = {
          id: task.id,
          columnId: task.columnId,
          title: task.title,
          description: task.description,
          position: task.position,
          assignee: task.assignee,
        };
        if (slice) {
          slice.push(reshaped);
        } else {
          tasksByColumn.set(task.columnId, [reshaped]);
        }
      }

      const hydrated: BoardColumnData[] = columnsData.columns.map((col) => ({
        id: col.id,
        projectId: col.projectId,
        name: col.name,
        position: col.position,
        tasks: tasksByColumn.get(col.id) ?? [],
      }));

      // Team-admin derivation: if the team-detail fetch failed (or the caller
      // has no per-team membership row), `isTeamAdmin` stays false and the
      // Add Column affordance is hidden. Tenant admins do NOT bypass — column
      // management is a team-scoped operation, mirroring the server-side
      // gate in POST /api/projects/[projectId]/columns.
      const callerMembership =
        callerId && teamDetail
          ? teamDetail.members.find((m) => m.userId === callerId) ?? null
          : null;

      setProject(projectData.project);
      setIsMember(projectData.isMember);
      setIsTeamAdmin(callerMembership?.role === "admin");
      // Surface the team membership roster (id + display fields only) so the
      // Add Task dialog can populate its assignee dropdown without re-fetch.
      // Falls back to an empty list if the team-detail fetch failed — the
      // dialog still renders with just the "Unassigned" option, which is the
      // correct degraded behavior.
      setTeamMembers(
        teamDetail
          ? teamDetail.members.map((m) => ({
              userId: m.userId,
              name: m.name,
              email: m.email,
            }))
          : [],
      );
      setColumns(hydrated);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 404) {
          setNotFound(true);
        } else if (err.status === 403) {
          setForbidden(true);
        } else {
          setError(err.message);
        }
      } else {
        setError("Unable to load the board.");
      }
    } finally {
      setLoading(false);
    }
  }, [callerId, teamId]);

  // Wait for the session to settle before firing the fetch — the dashboard
  // layout already gates on auth, but a stale "loading" status would still
  // produce a 401 if we raced ahead.
  useEffect(() => {
    if (sessionStatus === "loading") return;
    if (sessionStatus === "unauthenticated") return;
    void loadBoard();
  }, [loadBoard, sessionStatus]);

  // Append-on-success: the POST handler returns the freshly inserted column
  // (with its server-assigned id and position), so we splice it onto local
  // state without a full board refetch. Re-sort by `position` defensively in
  // case a sibling admin slipped a concurrent insert in between. Defined
  // here (above the early returns) so the hook order stays stable across
  // every render path.
  const handleColumnCreated = useCallback(
    (column: { id: string; projectId: string; name: string; position: number }) => {
      setColumns((prev) => {
        if (prev.some((c) => c.id === column.id)) return prev;
        const next = [
          ...prev,
          {
            id: column.id,
            projectId: column.projectId,
            name: column.name,
            position: column.position,
            tasks: [],
          },
        ];
        next.sort((a, b) => a.position - b.position);
        return next;
      });
    },
    [],
  );

  // Append-on-success for tasks: the POST handler returns the inflated task
  // (with server-assigned id, position, and the inlined assignee slice), so
  // we splice it onto the targeted column's task list without a full board
  // refetch. Re-sort by `position` defensively in case a sibling member
  // slipped a concurrent insert into the same lane between fetches.
  const handleTaskCreated = useCallback((task: BoardTask) => {
    setColumns((prev) =>
      prev.map((column) => {
        if (column.id !== task.columnId) return column;
        if (column.tasks.some((t) => t.id === task.id)) return column;
        const tasks = [...column.tasks, task];
        tasks.sort((a, b) => a.position - b.position);
        return { ...column, tasks };
      }),
    );
  }, []);

  // Splice-on-success for task deletes: the DELETE handler returns 204 with
  // no body, so the modal hands us only the deleted task's id. We walk every
  // column (rather than guessing the owning column from stale state) and
  // drop the matching row. A no-op pass through `prev` is returned when
  // nothing changes so React skips the re-render.
  const handleTaskDeleted = useCallback((taskId: string) => {
    setColumns((prev) => {
      let touched = false;
      const next = prev.map((column) => {
        const filtered = column.tasks.filter((t) => t.id !== taskId);
        if (filtered.length === column.tasks.length) return column;
        touched = true;
        return { ...column, tasks: filtered };
      });
      return touched ? next : prev;
    });
  }, []);

  // Sync-on-success for inline column renames. The PUT handler returns the
  // freshly-updated column row (id/projectId/name/position); we swap it onto
  // local state by id, preserving the existing `tasks` slice. Position can
  // theoretically shift between renames if a sibling admin reorders columns
  // mid-flight, so we re-sort defensively. We don't merge tasks from the
  // server response because the rename endpoint doesn't touch them — the
  // local task list is still authoritative.
  const handleColumnRenamed = useCallback(
    (column: { id: string; projectId: string; name: string; position: number }) => {
      setColumns((prev) => {
        let touched = false;
        const next = prev.map((existing) => {
          if (existing.id !== column.id) return existing;
          if (
            existing.name === column.name &&
            existing.position === column.position &&
            existing.projectId === column.projectId
          ) {
            return existing;
          }
          touched = true;
          return {
            ...existing,
            projectId: column.projectId,
            name: column.name,
            position: column.position,
          };
        });
        if (!touched) return prev;
        next.sort((a, b) => a.position - b.position);
        return next;
      });
    },
    [],
  );

  // Sync-on-success for task edits: the PUT handler returns the updated
  // task (including columnId/position, which the edit form doesn't touch
  // but we read defensively in case a future surface adds them). We swap
  // the matching row in the owning column's task list. Edits don't move
  // tasks across columns today — the move endpoint is a separate PATCH —
  // so we only have to walk one column. Position can theoretically shift
  // if a sibling re-orders the lane between fetches, so we re-sort
  // defensively.
  const handleTaskUpdated = useCallback((task: BoardTask) => {
    setColumns((prev) =>
      prev.map((column) => {
        if (column.id !== task.columnId) return column;
        let touched = false;
        const tasks = column.tasks.map((t) => {
          if (t.id !== task.id) return t;
          touched = true;
          return task;
        });
        if (!touched) return column;
        tasks.sort((a, b) => a.position - b.position);
        return { ...column, tasks };
      }),
    );
  }, []);

  // Resolve the column the "Add task" dialog is targeting (lifted up so the
  // dialog stays a single mounted instance). Memoized so the dialog props
  // stay referentially stable across unrelated re-renders.
  const addTaskColumn = useMemo(() => {
    if (!addTaskColumnId) return null;
    return columns.find((c) => c.id === addTaskColumnId) ?? null;
  }, [addTaskColumnId, columns]);

  /* --------------------------- Drag-and-drop ---------------------------- */

  // Active task being dragged — drives the `DragOverlay` clone. We snapshot
  // the BoardTask at drag-start (rather than re-deriving from columns on
  // every render) so the overlay still renders correctly while the source
  // card is mid-optimistic-splice.
  const [activeTask, setActiveTask] = useState<BoardTask | null>(null);

  // Snapshot of the columns slice taken at drag-start, so we can roll back
  // cleanly if the move endpoint fails. We use a ref (not state) because
  // the rollback never needs to drive a render — it overwrites `columns`
  // directly via `setColumns`.
  const rollbackSnapshotRef = useRef<BoardColumnData[] | null>(null);

  // Pointer-distance activation: a click of <6px doesn't trigger a drag,
  // so the existing "click card → open detail modal" path stays intact.
  // The keyboard sensor is intentionally omitted — its default activator
  // (Space) conflicts with the inner `<button>`'s click activation, and
  // wiring a separate visual handle would dilute the card affordance.
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const data = event.active.data.current as
        | { type?: string; task?: BoardTask }
        | undefined;
      if (data?.type !== "task" || !data.task) return;
      setActiveTask(data.task);
      rollbackSnapshotRef.current = columns;
    },
    [columns],
  );

  const handleDragCancel = useCallback(() => {
    setActiveTask(null);
    rollbackSnapshotRef.current = null;
  }, []);

  /**
   * Persist a move via PATCH /api/tasks/[taskId]/move with optimistic UI.
   *
   *   - Optimistic state: `setColumns(next)` is already applied by the
   *     caller. We only roll back on error.
   *   - Server response: re-stamps positions across the source + target
   *     columns. Rather than reconciling card-by-card, we just sync the
   *     moved task's columnId/position into the local row and rely on the
   *     re-stamp matching what we computed (the server's clamp + compaction
   *     algorithm is deterministic given the same inputs the optimistic
   *     splice used). If a sibling slips a concurrent insert, the next
   *     full-board refresh will reconcile.
   *   - On failure: restore the snapshot taken at drag-start and toast.
   */
  const persistMove = useCallback(
    async (
      taskId: string,
      targetColumnId: string,
      newPosition: number,
      snapshot: BoardColumnData[],
    ) => {
      try {
        const response = await apiClient.patch<{ task: BoardTask & { createdAt: string; updatedAt: string } }>(
          `/api/tasks/${taskId}/move`,
          { targetColumnId, newPosition },
          { silent: true, skipAuthRedirect: false },
        );
        // Sync the moved task's authoritative fields back onto local
        // state. We trust the server on columnId/position/assignee — the
        // optimistic splice should already match, but re-stamping defensively
        // keeps state consistent if a concurrent edit landed in between.
        const moved = response.task;
        setColumns((prev) =>
          prev.map((column) => {
            if (column.id !== moved.columnId) return column;
            let touched = false;
            const tasks = column.tasks.map((t) => {
              if (t.id !== moved.id) return t;
              touched = true;
              return {
                id: moved.id,
                columnId: moved.columnId,
                title: moved.title,
                description: moved.description,
                position: moved.position,
                assignee: moved.assignee,
              };
            });
            if (!touched) return column;
            return { ...column, tasks };
          }),
        );
      } catch (err) {
        // Roll back to the pre-drag snapshot. We pass the snapshot in
        // explicitly (rather than reading from the ref) because a fast
        // user could have started a second drag while the PATCH was in
        // flight — the ref would be pointing at the wrong moment in time.
        setColumns(snapshot);
        const description =
          err instanceof ApiError
            ? err.message
            : "We couldn't move that task. Please try again.";
        toast.error("Couldn't move task", { description });
      } finally {
        rollbackSnapshotRef.current = null;
      }
    },
    [],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      const snapshot = rollbackSnapshotRef.current;
      // Always clear the overlay clone — even on a no-op drop, the source
      // should stop reading as "being dragged".
      setActiveTask(null);

      if (!over || !snapshot) {
        rollbackSnapshotRef.current = null;
        return;
      }

      const activeId = String(active.id);
      const activeData = active.data.current as
        | { type?: string; task?: BoardTask; columnId?: string }
        | undefined;
      if (activeData?.type !== "task") {
        rollbackSnapshotRef.current = null;
        return;
      }

      // Resolve the source column from the snapshot — the caller's
      // pre-drag state is the source of truth here, since by the time we
      // observe `over` the optimistic state may already differ if dnd-kit
      // emits any midstream updates.
      const sourceColumn = snapshot.find((col) =>
        col.tasks.some((t) => t.id === activeId),
      );
      if (!sourceColumn) {
        rollbackSnapshotRef.current = null;
        return;
      }

      // Resolve target column + insert index from the over-element type.
      const overData = over.data.current as
        | {
            type?: string;
            task?: BoardTask;
            columnId?: string;
          }
        | undefined;

      let targetColumnId: string;
      let newPosition: number;

      if (overData?.type === "task" && overData.task && overData.columnId) {
        // Hovered over another task — drop relative to that task.
        targetColumnId = overData.columnId;
        const targetCol = snapshot.find((c) => c.id === targetColumnId);
        if (!targetCol) {
          rollbackSnapshotRef.current = null;
          return;
        }
        // Index of the over-task in the *original* (snapshot) lane. The
        // server's "newPosition" semantics match dnd-kit's default
        // `arrayMove(items, oldIndex, overIndex)`: the moving task ends up
        // exactly at `overIndex` after the splice (within the same lane),
        // and at `overIndex` (insert-before) when crossing lanes. So we
        // forward the snapshot index directly.
        newPosition = targetCol.tasks.findIndex(
          (t) => t.id === overData.task!.id,
        );
        if (newPosition < 0) {
          rollbackSnapshotRef.current = null;
          return;
        }
      } else if (overData?.type === "column" && overData.columnId) {
        // Hovered over a column body (typically: empty lane or trailing
        // whitespace). Append to the end of the target column. For a
        // same-column drop here, we use `length - 1` since the moving task
        // is already in the column and "append" really means "park at the
        // last slot" — server clamps anyway, but matching the math keeps
        // the optimistic state from temporarily showing the card past the
        // end.
        targetColumnId = overData.columnId;
        const targetCol = snapshot.find((c) => c.id === targetColumnId);
        if (!targetCol) {
          rollbackSnapshotRef.current = null;
          return;
        }
        const sameColumn = sourceColumn.id === targetColumnId;
        newPosition = sameColumn
          ? Math.max(targetCol.tasks.length - 1, 0)
          : targetCol.tasks.length;
      } else {
        rollbackSnapshotRef.current = null;
        return;
      }

      // Compute the optimistic next state.
      const next = applyOptimisticMove(
        snapshot,
        activeId,
        targetColumnId,
        newPosition,
      );
      if (!next) {
        // Couldn't locate the moving task — bail and clear the snapshot.
        rollbackSnapshotRef.current = null;
        return;
      }

      // No-op drop: source column + position unchanged. Skip the round
      // trip entirely so dragging a card and dropping it back where it
      // started doesn't churn the database.
      const sameColumn = sourceColumn.id === targetColumnId;
      const oldIndex = sourceColumn.tasks.findIndex((t) => t.id === activeId);
      if (sameColumn && oldIndex === newPosition) {
        rollbackSnapshotRef.current = null;
        return;
      }

      setColumns(next);
      void persistMove(activeId, targetColumnId, newPosition, snapshot);
    },
    [persistMove],
  );

  /* ------------------------------- Render -------------------------------- */

  if (sessionStatus === "loading" || (loading && !project && !error && !notFound && !forbidden)) {
    return <BoardLoadingState />;
  }

  if (notFound) {
    return <BoardNotFoundState />;
  }

  if (forbidden) {
    return <BoardForbiddenState />;
  }

  if (error && !project) {
    return <BoardErrorState message={error} onRetry={() => void loadBoard()} />;
  }

  return (
    <>
      <DndContext
        sensors={sensors}
        // closestCorners works well for a kanban: the active card's corners
        // get matched against both sortable items (siblings) and the column
        // droppable, so dropping near the top of a lane reliably resolves
        // to the first task and dropping past the last card resolves to
        // the column's whitespace.
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <BoardLayout
          teamId={teamId}
          project={project}
          isMember={isMember}
          isTeamAdmin={isTeamAdmin}
          columns={columns}
          loading={loading}
          onRefresh={() => void loadBoard()}
          onRequestAddColumn={() => setAddColumnOpen(true)}
          onRequestAddTask={(columnId) => setAddTaskColumnId(columnId)}
          onSelectTask={(task) => setDetailTaskId(task.id)}
          onColumnRenamed={handleColumnRenamed}
        />
        {/* The DragOverlay clone follows the cursor while a drag is in
            progress. We render a non-interactive `BoardTaskCard` (no
            `onSelect`) so the clone doesn't try to absorb pointer events
            — it's purely a visual mirror of the source card. The slight
            rotation + larger shadow are conventional cues that the card
            is "lifted" above the board. */}
        <DragOverlay dropAnimation={null}>
          {activeTask ? (
            <div className="rotate-2 cursor-grabbing shadow-2xl">
              <BoardTaskCard task={activeTask} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      {/* Mounted only when we know the projectId AND the caller is a team
          admin — the dialog needs the projectId to POST against, and the
          server will 403 a non-admin's submission anyway. */}
      {isTeamAdmin && project ? (
        <AddColumnDialog
          open={addColumnOpen}
          onOpenChange={setAddColumnOpen}
          projectId={project.id}
          onCreated={handleColumnCreated}
        />
      ) : null}
      {/* Mounted whenever the caller is a team member AND the project has
          resolved — non-members would 403 on submit, and the dialog needs
          the projectId in its POST. We unmount on dialog-close (rather than
          hide) so transient form state resets cleanly without a custom
          effect. */}
      {isMember && project && addTaskColumn ? (
        <AddTaskDialog
          open={Boolean(addTaskColumn)}
          onOpenChange={(next) => {
            if (!next) setAddTaskColumnId(null);
          }}
          projectId={project.id}
          teamId={teamId}
          columnId={addTaskColumn.id}
          columnName={addTaskColumn.name}
          members={teamMembers}
          onCreated={handleTaskCreated}
        />
      ) : null}
      {/* Task detail modal — single shared instance. We mount it
          unconditionally (the modal itself no-ops when `taskId` is null
          AND it isn't open) so opening a card animates in cleanly without
          a fresh mount. The modal re-fetches `GET /api/tasks/[taskId]`
          every time it opens, which is cheap and keeps the surface fresh.
          We forward `canEdit` (gated on team membership — non-members
          would 403 a save anyway) and the team roster so the in-modal
          edit form can populate its assignee dropdown without a fresh
          fetch. The `onUpdated` callback splices the freshly-saved task
          into the local board state, so the touched card reflects the
          new fields immediately. */}
      <TaskDetailModal
        open={detailTaskId !== null}
        onOpenChange={(next) => {
          if (!next) setDetailTaskId(null);
        }}
        taskId={detailTaskId}
        canEdit={isMember}
        members={teamMembers}
        teamId={teamId}
        onUpdated={handleTaskUpdated}
        onDeleted={handleTaskDeleted}
      />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Board layout                                  */
/* -------------------------------------------------------------------------- */

type BoardLayoutProps = {
  teamId: string;
  project: Project | null;
  isMember: boolean;
  isTeamAdmin: boolean;
  columns: BoardColumnData[];
  loading: boolean;
  onRefresh: () => void;
  onRequestAddColumn: () => void;
  onRequestAddTask: (columnId: string) => void;
  onSelectTask: (task: BoardTask) => void;
  onColumnRenamed: (column: {
    id: string;
    projectId: string;
    name: string;
    position: number;
  }) => void;
};

function BoardLayout({
  teamId,
  project,
  isMember,
  isTeamAdmin,
  columns,
  loading,
  onRefresh,
  onRequestAddColumn,
  onRequestAddTask,
  onSelectTask,
  onColumnRenamed,
}: BoardLayoutProps) {
  // The drag-to-reorder gesture mirrors the server-side member check on
  // PATCH /api/tasks/[taskId]/move. Visitors of a public project can still
  // click cards open, but the gesture stays hidden for them.
  const canReorder = isMember;
  const totalTasks = useMemo(
    () => columns.reduce((sum, col) => sum + col.tasks.length, 0),
    [columns],
  );

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <Button asChild variant="ghost" size="sm" className="-ml-3">
          <Link href={`/teams/${teamId}/members`}>
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back to team
          </Link>
        </Button>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1">
            <p className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Board
            </p>
            <h1 className="flex items-center gap-2 text-3xl font-semibold tracking-tight">
              <KanbanSquare className="h-7 w-7 text-muted-foreground" aria-hidden="true" />
              {project?.name ?? "Project"}
            </h1>
            <p className="text-sm text-muted-foreground">
              {columns.length} {columns.length === 1 ? "column" : "columns"} ·{" "}
              {totalTasks} {totalTasks === 1 ? "task" : "tasks"}
              {project?.visibility === "private"
                ? " · Private to team"
                : " · Visible to your tenant"}
              {isMember ? " · You're a team member" : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRefresh}
              disabled={loading}
              aria-label="Refresh board"
            >
              <RefreshCw
                className={cn("h-4 w-4", loading && "animate-spin")}
                aria-hidden="true"
              />
              <span>Refresh</span>
            </Button>
          </div>
        </div>
      </header>

      <BoardColumns
        columns={columns}
        projectId={project?.id ?? null}
        isMember={isMember}
        isTeamAdmin={isTeamAdmin}
        onRequestAddColumn={onRequestAddColumn}
        onRequestAddTask={onRequestAddTask}
        onSelectTask={onSelectTask}
        canReorder={canReorder}
        onColumnRenamed={onColumnRenamed}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Columns row                                   */
/* -------------------------------------------------------------------------- */

type BoardColumnsProps = {
  columns: BoardColumnData[];
  /**
   * Owning project id. May be null while the project fetch is still
   * resolving — the rename affordance is only enabled once we have a
   * concrete projectId to PUT against.
   */
  projectId: string | null;
  isMember: boolean;
  isTeamAdmin: boolean;
  onRequestAddColumn: () => void;
  onRequestAddTask: (columnId: string) => void;
  onSelectTask: (task: BoardTask) => void;
  /**
   * When true, task cards are draggable and columns are drop targets. The
   * gesture is gated on team membership (the move endpoint 403s for
   * non-members), so visitors of a public project still see a clickable
   * read-only board but no drag affordance.
   */
  canReorder: boolean;
  onColumnRenamed: (column: {
    id: string;
    projectId: string;
    name: string;
    position: number;
  }) => void;
};

function BoardColumns({
  columns,
  projectId,
  isMember,
  isTeamAdmin,
  onRequestAddColumn,
  onRequestAddTask,
  onSelectTask,
  canReorder,
  onColumnRenamed,
}: BoardColumnsProps) {
  if (columns.length === 0) {
    return (
      <BoardEmptyState
        isMember={isMember}
        isTeamAdmin={isTeamAdmin}
        onRequestAddColumn={onRequestAddColumn}
      />
    );
  }

  // Team admins can keep adding columns up to the server-side cap of 10.
  // We hide the trigger past the cap so the affordance doesn't lure the
  // admin into a guaranteed 422 — the server is still authoritative on the
  // limit (concurrent inserts could push us over the threshold between
  // renders), but this keeps the happy-path UI clean.
  const canAddColumn = isTeamAdmin && columns.length < 10;

  return (
    // The board lives inside the dashboard's max-w-6xl container; we break
    // out of the container's right edge with negative horizontal padding +
    // a `-mx-` of the same magnitude so the horizontal scroll affordance
    // bleeds to the viewport edge on narrower screens. `overflow-x-auto`
    // keeps scrolling local to the row rather than the page.
    <div
      className="-mx-4 overflow-x-auto pb-4 sm:-mx-6"
      role="region"
      aria-label="Kanban board"
    >
      <div className="flex gap-4 px-4 sm:gap-5 sm:px-6">
        {columns.map((column) => (
          <BoardColumn
            key={column.id}
            column={column}
            // Team-member gate: only members can append tasks (the server
            // 403s non-members regardless of project visibility). Hiding the
            // affordance keeps the read-only experience clean for visitors
            // on a public project.
            canAddTask={isMember}
            onRequestAddTask={() => onRequestAddTask(column.id)}
            // Click on any card in this lane opens the shared task-detail
            // modal mounted by the parent KanbanBoard. Visitors of a public
            // project (non-members) still get this — the GET endpoint only
            // requires tenant + project visibility, not membership.
            onSelectTask={onSelectTask}
            // Drag-to-reorder is gated on the same team-member rule as
            // task creation, since the move endpoint enforces the check
            // server-side anyway.
            canReorder={canReorder}
            // Inline rename gate mirrors the server-side team-admin check
            // on PUT /api/projects/[projectId]/columns/[columnId]. Tenant
            // admins do NOT bypass; column management is team-scoped.
            canEditName={isTeamAdmin}
            projectId={projectId ?? undefined}
            onRenamed={onColumnRenamed}
          />
        ))}
        {canAddColumn ? (
          <AddColumnTrigger onClick={onRequestAddColumn} />
        ) : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                            Add column trigger                              */
/* -------------------------------------------------------------------------- */

/**
 * "Add column" affordance rendered as the trailing tile in the columns row.
 * Sized to match a real column so the row's vertical rhythm stays consistent
 * — a dashed border + muted background signals "placeholder", and the icon
 * + label give the click target a clear purpose at any width.
 */
function AddColumnTrigger({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Add column"
      className={cn(
        "flex w-64 shrink-0 flex-col items-center justify-center gap-2",
        "rounded-lg border border-dashed bg-muted/30 px-3 py-6 text-sm font-medium text-muted-foreground",
        "transition-colors hover:border-foreground/40 hover:bg-muted/60 hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background",
        "md:w-72 lg:w-80",
      )}
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-full border bg-background">
        <Plus className="h-4 w-4" aria-hidden="true" />
      </span>
      <span>Add column</span>
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Empty state                                   */
/* -------------------------------------------------------------------------- */

function BoardEmptyState({
  isMember,
  isTeamAdmin,
  onRequestAddColumn,
}: {
  isMember: boolean;
  isTeamAdmin: boolean;
  onRequestAddColumn: () => void;
}) {
  return (
    <div
      className="rounded-lg border border-dashed bg-background px-6 py-12 text-center"
      role="status"
    >
      <Layers
        className="mx-auto h-8 w-8 text-muted-foreground"
        aria-hidden="true"
      />
      <p className="mt-3 text-base font-medium">No columns yet</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
        {isTeamAdmin
          ? "Add the first column to start organizing this board."
          : isMember
            ? "A team admin can add columns to start organizing this board."
            : "This board doesn't have any columns yet. Check back once the team has set things up."}
      </p>
      {isTeamAdmin ? (
        <div className="mt-4 flex justify-center">
          <Button type="button" onClick={onRequestAddColumn}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add column
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Skeleton state                                */
/* -------------------------------------------------------------------------- */

function BoardLoadingState() {
  // We render a header placeholder + three skeleton columns with two card
  // skeletons each. The skeleton column count is intentionally small and
  // static — it's representative without claiming to know the real shape,
  // and the post-load reflow stays minimal.
  const skeletonColumns = 3;

  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <header className="space-y-3">
        <div className="h-8 w-32 animate-pulse rounded-md bg-muted" />
        <div className="space-y-2">
          <div className="h-4 w-20 animate-pulse rounded-md bg-muted" />
          <div className="h-9 w-64 animate-pulse rounded-md bg-muted" />
          <div className="h-4 w-72 animate-pulse rounded-md bg-muted" />
        </div>
      </header>
      <div
        className="-mx-4 overflow-x-hidden pb-4 sm:-mx-6"
        role="status"
        aria-label="Loading board"
      >
        <div className="flex gap-4 px-4 sm:gap-5 sm:px-6">
          {Array.from({ length: skeletonColumns }).map((_, idx) => (
            <BoardColumnSkeleton key={idx} />
          ))}
        </div>
      </div>
      <span className="sr-only">Loading board…</span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                       Not-found / forbidden / error                        */
/* -------------------------------------------------------------------------- */

function BoardNotFoundState() {
  return (
    <div className="space-y-4">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/teams">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          All teams
        </Link>
      </Button>
      <div
        role="alert"
        className="rounded-lg border border-dashed bg-background px-6 py-10 text-center"
      >
        <KanbanSquare
          className="mx-auto h-8 w-8 text-muted-foreground"
          aria-hidden="true"
        />
        <p className="mt-2 text-sm font-medium">Board not found</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          This team&apos;s board has been deleted or you don&apos;t have access
          to it.
        </p>
      </div>
    </div>
  );
}

function BoardForbiddenState() {
  return (
    <div className="space-y-4">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/teams">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          All teams
        </Link>
      </Button>
      <div
        role="alert"
        className="rounded-lg border border-dashed bg-background px-6 py-10 text-center"
      >
        <Lock
          className="mx-auto h-8 w-8 text-muted-foreground"
          aria-hidden="true"
        />
        <p className="mt-2 text-sm font-medium">Private board</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          You don&apos;t have access to this team&apos;s board. Ask a team
          admin to add you as a member.
        </p>
      </div>
    </div>
  );
}

function BoardErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="space-y-4">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/teams">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          All teams
        </Link>
      </Button>
      <div
        role="alert"
        className="flex items-start justify-between gap-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
      >
        <div className="flex items-start gap-2">
          <AlertCircle className="mt-0.5 h-4 w-4" aria-hidden="true" />
          <span>{message}</span>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}
