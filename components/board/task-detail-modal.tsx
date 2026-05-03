"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import {
  AlertCircle,
  CalendarClock,
  CalendarPlus,
  Download,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Loader2,
  Paperclip,
  Pencil,
  RefreshCw,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";

import { ApiError, apiClient } from "@/lib/client/api-client";
import { cn } from "@/lib/client/utils";
import {
  AssigneeSelect,
  type AssigneeMember,
} from "@/components/board/assignee-select";
import {
  AttachmentUploader,
  type UploadedAttachment,
} from "@/components/board/attachment-uploader";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { AddTaskTeamMember } from "@/components/board/add-task-dialog";
import type { BoardTask } from "@/components/board/types";

/* -------------------------------------------------------------------------- */
/*                                API contract                                */
/* -------------------------------------------------------------------------- */

/**
 * Mirrors the response of `GET /api/tasks/[taskId]`.
 *
 * The handler inlines an `assignee` slice (`{ id, name, email }`) when one is
 * set — `null` otherwise — and ships an `attachments` array describing the
 * files persisted against the task. Each attachment can be downloaded via
 * `GET /api/attachments/[attachmentId]`; the modal renders that as a link
 * row with a MIME-mapped icon, filename, and size — see {@link AttachmentRow}.
 */
type TaskDetailAssignee = {
  id: string;
  name: string | null;
  email: string;
};

type TaskDetailAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  // The handler returns `Date` instances for timestamps which serialize to
  // ISO strings on the wire. We keep that as `string` here — the modal only
  // needs it to render relative/absolute dates.
  createdAt: string;
};

type TaskDetail = {
  id: string;
  columnId: string;
  title: string;
  description: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
  assignee: TaskDetailAssignee | null;
  attachments: TaskDetailAttachment[];
};

type TaskDetailResponse = { task: TaskDetail };

/**
 * Mirrors the response of `PUT /api/tasks/[taskId]`. The shape matches
 * `TaskDetail` minus the `attachments` field — the write endpoint doesn't
 * touch attachments so the response omits the array. We map back into the
 * detail shape locally by preserving the existing `attachments` array.
 */
type UpdatedTask = Omit<TaskDetail, "attachments">;
type UpdateTaskResponse = { task: UpdatedTask };

/* -------------------------------------------------------------------------- */
/*                                Constants                                   */
/* -------------------------------------------------------------------------- */

/** Mirrors the server-side validation in `PUT /api/tasks/[taskId]`. Keep
 *  these in sync with the API so the user gets immediate client-side
 *  feedback before incurring a 400 round-trip. */
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 10_000;

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

/**
 * Two-character initials fallback for the assignee avatar. Mirrors the helper
 * used in `board-task-card.tsx` so the avatar affordance reads consistently
 * across surfaces.
 */
const initialsFromAssignee = (assignee: TaskDetailAssignee): string => {
  const source = (assignee.name ?? assignee.email).trim();
  if (!source) return "?";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

/**
 * Format an ISO timestamp with the user's locale. We render an absolute
 * timestamp (rather than relative "X minutes ago") because relative copy
 * needs a clock tick to stay accurate; the absolute string is unambiguous
 * the moment the modal opens.
 */
const formatTimestamp = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

/**
 * Human-readable file size. We intentionally avoid pulling in a sizing
 * library for this single use — three branches cover every realistic
 * attachment magnitude.
 */
const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * Pick a lucide-react icon for an attachment row based on its MIME type.
 *
 * Strategy: match the broad media-type prefix first (image/video/audio/text),
 * then fall back to a small whitelist of commonly-uploaded application/*
 * subtypes (archives, code, spreadsheets, json, pdf). Anything we don't
 * recognise gets the generic {@link FileIcon} so the row always renders an
 * icon — never an empty slot.
 *
 * The whitelist intentionally mirrors the MIME types the upload endpoint
 * accepts so every attachment that successfully made it into the DB resolves
 * to a meaningful glyph; we still keep the generic fallback for forward-
 * compatibility with new types added on the server side without a UI change.
 */
const iconForMimeType = (mimeType: string): LucideIcon => {
  // Normalise to lower-case so a `Image/PNG` from a misbehaving uploader
  // still hits the prefix match. We split on `;` so parameter-laden types
  // like `text/plain; charset=utf-8` collapse to just `text/plain` for the
  // exact-match branches below.
  const normalised = mimeType.toLowerCase().split(";", 1)[0].trim();

  if (normalised.startsWith("image/")) return FileImage;
  if (normalised.startsWith("video/")) return FileVideo;
  if (normalised.startsWith("audio/")) return FileAudio;

  // Specific subtypes get a more precise glyph than the generic text/* one.
  switch (normalised) {
    case "application/pdf":
      // No dedicated lucide PDF glyph; FileText reads as "document" and is
      // the closest visual match.
      return FileText;
    case "application/json":
    case "application/ld+json":
      return FileJson;
    case "application/zip":
    case "application/x-zip-compressed":
    case "application/x-tar":
    case "application/gzip":
    case "application/x-gzip":
    case "application/x-7z-compressed":
    case "application/x-rar-compressed":
    case "application/vnd.rar":
      return FileArchive;
    case "application/vnd.ms-excel":
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    case "application/vnd.oasis.opendocument.spreadsheet":
    case "text/csv":
    case "text/tab-separated-values":
      return FileSpreadsheet;
    case "application/javascript":
    case "application/x-javascript":
    case "application/typescript":
    case "application/xml":
    case "application/x-sh":
    case "application/x-yaml":
    case "text/javascript":
    case "text/x-python":
    case "text/x-c":
    case "text/x-java-source":
    case "text/html":
    case "text/css":
    case "text/xml":
    case "text/yaml":
      return FileCode;
  }

  // Plain text falls through to the prefix match here, after the more
  // specific text/* subtypes above have had a chance.
  if (normalised.startsWith("text/")) return FileText;

  return FileIcon;
};

/* -------------------------------------------------------------------------- */
/*                                  Component                                 */
/* -------------------------------------------------------------------------- */

export type TaskDetailModalProps = {
  /** Controls dialog visibility. */
  open: boolean;
  /** Notifies the parent when the dialog wants to close. */
  onOpenChange: (open: boolean) => void;
  /**
   * Task id to fetch. May be null when the dialog is closed — we only fire
   * the request when both `open` is true and `taskId` is set, so toggling
   * the dialog without a task selected stays a no-op. Changing the id while
   * the dialog is open swaps the underlying fetch (skeleton → new content).
   */
  taskId: string | null;
  /**
   * Whether the caller has write access on the task. Gates the Edit button.
   * The PUT endpoint requires team membership of the owning team — non-
   * members would 403 a save anyway — so the parent passes `isMember` here.
   * Defaults to false so a parent that hasn't opted in keeps the modal
   * read-only.
   */
  canEdit?: boolean;
  /**
   * Members of the owning team, surfaced in the assignee dropdown of the
   * edit form. The server enforces that the assignee must be a team member,
   * so the dropdown is restricted to this list. Optional — when absent, the
   * AssigneeSelect falls back to fetching `/api/teams/[teamId]/members` on
   * its own (provided `teamId` is supplied) so the dropdown stays usable.
   */
  members?: AddTaskTeamMember[];
  /**
   * Owning team id. Forwarded to the in-modal {@link AssigneeSelect} so it
   * can fall back to fetching the membership roster from
   * `/api/teams/[teamId]/members` when `members` isn't preloaded by the
   * caller. Optional — the assignee picker degrades gracefully without it,
   * but a missing teamId AND missing members combination leaves the dropdown
   * with only the "Unassign" affordance + current assignee fallback.
   */
  teamId?: string;
  /**
   * Called with the freshly-saved task on a successful edit. The caller is
   * expected to splice the update into its local board state so the
   * touched card reflects the new fields without a full board refetch.
   */
  onUpdated?: (task: BoardTask) => void;
  /**
   * Called with the deleted task's id on a successful delete. The caller is
   * expected to remove the matching card from its local board state so the
   * deletion is reflected without a full board refetch. The modal closes
   * itself once the callback returns.
   */
  onDeleted?: (taskId: string) => void;
};

/**
 * Detail view for a single task, opened from a card click on the kanban
 * board. Driven entirely by `GET /api/tasks/[taskId]` for the read path
 * (the parent only has to hand us the id) and by `PUT /api/tasks/[taskId]`
 * for the in-modal edit path.
 *
 * Two modes:
 *
 *   - **View** (default): renders the title, the markdown-rendered
 *     description, assignee identity, attachments (with download links),
 *     and the created/updated timestamps. An "Edit" affordance in the
 *     footer flips the body to edit mode (gated on `canEdit`).
 *   - **Edit**: replaces the title/description/assignee sections with
 *     editable inputs, validates client-side (title non-empty, length
 *     caps), and on save PUTs to `/api/tasks/[taskId]`. On success we
 *     update the modal's local task state so the view-mode read reflects
 *     the new fields immediately, fire `onUpdated` so the parent can sync
 *     the board's local task list, show a confirmation toast, and flip
 *     back to view mode.
 *
 * Loading + error UX:
 *
 *   - While the GET request is in flight, renders a skeleton placeholder so
 *     the dialog content area doesn't reflow when data lands.
 *   - On a load error, renders an alert with a Retry button so a transient
 *     network blip doesn't force the user to close + reopen.
 *
 * Implementation notes:
 *
 *   - The fetch effect keys on `(open, taskId)` so re-opening the same task
 *     re-fetches (cheap freshness guarantee) and switching tasks while the
 *     dialog is open swaps content cleanly. We track an in-flight cancel
 *     token (`abort` ref via local boolean) so a stale response from a
 *     previous render path can't overwrite a newer one.
 *   - We render the Dialog wrapper unconditionally so the open→close
 *     animation runs through Radix; gating the content on `taskId` keeps
 *     the rendered tree stable while the dialog is closed.
 *   - The shipped `Dialog` primitive already includes a top-right close (X)
 *     button (see `components/ui/dialog.tsx`); the footer carries explicit
 *     Close / Edit / Save / Cancel affordances depending on the mode.
 *   - The dialog can't be dismissed while a save is in flight — we'd
 *     otherwise lose the result of an already-in-flight PUT.
 */
export function TaskDetailModal({
  open,
  onOpenChange,
  taskId,
  canEdit = false,
  members,
  teamId,
  onUpdated,
  onDeleted,
}: TaskDetailModalProps) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  // Bumped to force a refetch from the Retry button without changing taskId.
  const [retryCounter, setRetryCounter] = useState(0);
  // View / edit mode flag. We always re-enter view mode on (re)open so a
  // user who closed mid-edit and reopens the same task lands in the read
  // surface — discarding edits explicitly is a Cancel button decision.
  const [editing, setEditing] = useState(false);
  // Save in-flight indicator. While true the dialog can't be dismissed and
  // the form controls are disabled.
  const [saving, setSaving] = useState(false);
  // Confirm-delete dialog visibility. Lifted into the modal so the read-body
  // and the AlertDialog stay coordinated — the delete trigger flips this on
  // and the AlertDialog drives it back off via Cancel / outside-blocked
  // dismiss / completed action.
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  // Delete in-flight indicator. While true the AlertDialog can't be
  // dismissed (Cancel disabled, outside-click ignored) and the parent
  // Dialog also blocks dismissal so the user can't navigate away mid-call.
  const [deleting, setDeleting] = useState(false);

  // Reset transient state every time the dialog closes so a re-open on the
  // same id doesn't briefly flash the previous task's content (or stale
  // error) before the new fetch resolves.
  useEffect(() => {
    if (!open) {
      setTask(null);
      setError(null);
      setNotFound(false);
      setForbidden(false);
      setLoading(false);
      setEditing(false);
      setSaving(false);
      setConfirmDeleteOpen(false);
      setDeleting(false);
    }
  }, [open]);

  // Drive the actual fetch. Effect runs whenever the dialog opens, the task
  // id changes, or the user clicks Retry. The `cancelled` flag protects
  // against a stale response landing after a faster successor (or after the
  // dialog has closed) — without it we could overwrite freshly-cleared
  // state with old data.
  useEffect(() => {
    if (!open || !taskId) return;

    let cancelled = false;
    setLoading(true);
    setError(null);
    setNotFound(false);
    setForbidden(false);
    // Switching tasks (or re-fetching via Retry) returns us to view mode so
    // a stale edit form for a different task can't survive the transition.
    setEditing(false);

    apiClient
      .get<TaskDetailResponse>(`/api/tasks/${taskId}`, {
        silent: true,
        skipAuthRedirect: true,
      })
      .then((data) => {
        if (cancelled) return;
        setTask(data.task);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError) {
          if (err.status === 404) {
            setNotFound(true);
          } else if (err.status === 403) {
            setForbidden(true);
          } else {
            setError(err.message);
          }
        } else {
          setError("Unable to load task.");
        }
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, taskId, retryCounter]);

  // Splice a freshly-uploaded attachment into the modal's local task state
  // so the new row renders without a full task refetch. The attachment
  // upload endpoint is fire-and-forget at the parent level (the kanban
  // board doesn't track attachments per card), so we only need to update
  // local state — no parent callback is required here.
  const applyAttachmentAdded = useCallback(
    (attachment: UploadedAttachment) => {
      setTask((prev) =>
        prev
          ? {
              ...prev,
              attachments: prev.attachments.some((a) => a.id === attachment.id)
                ? prev.attachments
                : [...prev.attachments, attachment],
            }
          : prev,
      );
    },
    [],
  );

  // Apply a successful save: update the modal's local task state in-place
  // (so the view mode renders the new fields without a re-fetch) and
  // forward a board-shaped slice to the parent so it can sync the touched
  // card. We preserve the existing `attachments` array — the PUT endpoint
  // doesn't touch attachments and its response omits the field.
  const applyUpdate = useCallback(
    (updated: UpdatedTask) => {
      setTask((prev) =>
        prev
          ? {
              ...prev,
              title: updated.title,
              description: updated.description,
              assignee: updated.assignee,
              updatedAt: updated.updatedAt,
              // columnId / position / createdAt are echoed unchanged by the
              // PUT handler, but we still trust the response to absorb any
              // drift the server might surface in the future.
              columnId: updated.columnId,
              position: updated.position,
              createdAt: updated.createdAt,
            }
          : prev,
      );

      onUpdated?.({
        id: updated.id,
        columnId: updated.columnId,
        title: updated.title,
        description: updated.description,
        position: updated.position,
        assignee: updated.assignee,
      });
    },
    [onUpdated],
  );

  // Confirmed delete path. Fires DELETE /api/tasks/[taskId], surfaces a
  // success toast, lets the parent splice the card out of local board
  // state, and closes both the AlertDialog and the parent Dialog. On
  // failure we keep the AlertDialog open so the user can retry without
  // losing context — the toast describes what went wrong.
  const handleConfirmDelete = useCallback(async () => {
    if (!task || deleting) return;
    setDeleting(true);
    try {
      await apiClient.delete(`/api/tasks/${task.id}`, {
        silent: true,
        skipAuthRedirect: true,
      });
      toast.success("Task deleted", {
        description: `“${task.title}” has been deleted.`,
      });
      onDeleted?.(task.id);
      // Close the confirmation dialog AND the parent modal in one shot.
      // We flip these in sequence (rather than relying solely on the parent
      // Dialog's onOpenChange) so the AlertDialog's exit animation runs
      // before the parent unmounts the modal subtree.
      setConfirmDeleteOpen(false);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 404) {
          // The row is already gone — treat as a successful no-op so the
          // user isn't stuck on a stale card. Forward to the parent so the
          // local board state catches up.
          toast.success("Task deleted", {
            description: "This task was already removed.",
          });
          onDeleted?.(task.id);
          setConfirmDeleteOpen(false);
          onOpenChange(false);
        } else {
          toast.error("Couldn't delete task", { description: err.message });
        }
      } else {
        toast.error("Couldn't delete task", {
          description: "Something went wrong. Please try again.",
        });
      }
    } finally {
      setDeleting(false);
    }
  }, [deleting, onDeleted, onOpenChange, task]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Block dismiss while a save or delete is in flight so we don't
        // strand the user without confirmation of the result.
        if ((saving || deleting) && !next) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        className={cn(
          // The default content max-w-lg is right for a quick form, but the
          // task detail surface needs more room for description prose +
          // attachments side-by-side on wider screens. Cap it so the modal
          // never feels like a full-page takeover on a wide monitor.
          "max-w-2xl max-h-[85vh] overflow-y-auto",
        )}
      >
        {loading || (!task && !error && !notFound && !forbidden) ? (
          <TaskDetailSkeleton />
        ) : notFound ? (
          <TaskDetailNotFoundState onClose={() => onOpenChange(false)} />
        ) : forbidden ? (
          <TaskDetailForbiddenState onClose={() => onOpenChange(false)} />
        ) : error ? (
          <TaskDetailErrorState
            message={error}
            onRetry={() => setRetryCounter((n) => n + 1)}
            onClose={() => onOpenChange(false)}
          />
        ) : task ? (
          editing ? (
            <TaskDetailEditForm
              task={task}
              members={members ?? []}
              teamId={teamId}
              saving={saving}
              setSaving={setSaving}
              onCancel={() => setEditing(false)}
              onSaved={(updated) => {
                applyUpdate(updated);
                setEditing(false);
              }}
            />
          ) : (
            <TaskDetailBody
              task={task}
              canEdit={canEdit}
              onEdit={() => setEditing(true)}
              onClose={() => onOpenChange(false)}
              onRequestDelete={() => setConfirmDeleteOpen(true)}
              onAttachmentAdded={applyAttachmentAdded}
            />
          )
        ) : null}
      </DialogContent>
      {/* Delete-confirmation AlertDialog. Mounted as a sibling of the parent
          Dialog (rather than nested inside DialogContent) so the alert's
          overlay stacks above the modal cleanly and Radix can manage focus
          correctly between the two surfaces. We only enable confirm when a
          task is actually loaded — the trigger is gated on `canEdit && task`
          so this is a defensive guard against an interleaved state flip. */}
      {task ? (
        <AlertDialog
          open={confirmDeleteOpen}
          onOpenChange={(next) => {
            // Block dismissal while the DELETE is in flight so the user
            // can't navigate away mid-call and miss the toast.
            if (deleting && !next) return;
            setConfirmDeleteOpen(next);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this task?</AlertDialogTitle>
              <AlertDialogDescription>
                “{task.title}” will be permanently removed. This can&apos;t be
                undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
              {/* The Action is themed as destructive — irreversible removal
                  warrants the louder color. We override the default
                  buttonVariants() class via className. */}
              <AlertDialogAction
                className={cn(buttonVariants({ variant: "destructive" }))}
                disabled={deleting}
                onClick={(event) => {
                  // Prevent Radix's default "close on action" behavior so we
                  // can keep the AlertDialog open until the network round-
                  // trip resolves. Without this, the dialog closes
                  // immediately on click and a slow/failing DELETE would
                  // strand the user with no feedback surface.
                  event.preventDefault();
                  void handleConfirmDelete();
                }}
              >
                {deleting ? (
                  <>
                    <Loader2
                      className="h-4 w-4 animate-spin"
                      aria-hidden="true"
                    />
                    Deleting…
                  </>
                ) : (
                  <>
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                    Delete
                  </>
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Detail body                                   */
/* -------------------------------------------------------------------------- */

function TaskDetailBody({
  task,
  canEdit,
  onEdit,
  onClose,
  onRequestDelete,
  onAttachmentAdded,
}: {
  task: TaskDetail;
  canEdit: boolean;
  onEdit: () => void;
  onClose: () => void;
  onRequestDelete: () => void;
  onAttachmentAdded: (attachment: UploadedAttachment) => void;
}) {
  return (
    <>
      <DialogHeader>
        {/* Pre-wrap the title so a long string breaks across lines instead
            of pushing the close (X) button off-canvas. The pr-8 reserves
            space for the absolute-positioned close button in DialogContent. */}
        <DialogTitle className="break-words pr-8">{task.title}</DialogTitle>
        {/* The DialogDescription gives us a stable a11y target for the
            dialog's overall purpose ("task detail"), separate from the
            rendered description body below. */}
        <DialogDescription className="sr-only">
          Task details, including description, assignee, attachments, and
          timestamps.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-6">
        {/* ---------- Description ---------- */}
        <section aria-labelledby="task-detail-description-heading" className="space-y-2">
          <h3
            id="task-detail-description-heading"
            className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Description
          </h3>
          {task.description ? (
            <MarkdownDescription source={task.description} />
          ) : (
            <p className="text-sm italic text-muted-foreground">
              No description provided.
            </p>
          )}
        </section>

        {/* ---------- Assignee ---------- */}
        <section aria-labelledby="task-detail-assignee-heading" className="space-y-2">
          <h3
            id="task-detail-assignee-heading"
            className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Assignee
          </h3>
          {task.assignee ? (
            <AssigneeRow assignee={task.assignee} />
          ) : (
            <p className="text-sm italic text-muted-foreground">Unassigned</p>
          )}
        </section>

        {/* ---------- Attachments ---------- */}
        <section aria-labelledby="task-detail-attachments-heading" className="space-y-2">
          <h3
            id="task-detail-attachments-heading"
            className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
            Attachments
            <span className="text-muted-foreground/70">
              ({task.attachments.length})
            </span>
          </h3>
          {task.attachments.length === 0 ? (
            <p className="text-sm italic text-muted-foreground">
              No attachments.
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-md border" role="list">
              {task.attachments.map((attachment) => (
                <li key={attachment.id}>
                  <AttachmentRow attachment={attachment} />
                </li>
              ))}
            </ul>
          )}
          {/* Upload affordance — gated on team membership (the POST
              endpoint 403s non-members, so the uploader returns null when
              `disabled` is set). The uploader handles its own client-side
              size / type / count validation and surfaces toasts for limit
              violations, then calls back here on success to splice the
              fresh attachment into the local task state. */}
          <AttachmentUploader
            taskId={task.id}
            count={task.attachments.length}
            disabled={!canEdit}
            onUploaded={onAttachmentAdded}
          />
        </section>

        {/* ---------- Timestamps ---------- */}
        <section
          aria-labelledby="task-detail-timestamps-heading"
          className="space-y-2 border-t pt-4"
        >
          <h3
            id="task-detail-timestamps-heading"
            className="sr-only"
          >
            Timestamps
          </h3>
          <dl className="grid grid-cols-1 gap-2 text-xs text-muted-foreground sm:grid-cols-2">
            <div className="flex items-center gap-2">
              <CalendarPlus className="h-3.5 w-3.5" aria-hidden="true" />
              <dt className="font-medium">Created</dt>
              <dd>
                <time dateTime={task.createdAt}>
                  {formatTimestamp(task.createdAt)}
                </time>
              </dd>
            </div>
            <div className="flex items-center gap-2">
              <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
              <dt className="font-medium">Updated</dt>
              <dd>
                <time dateTime={task.updatedAt}>
                  {formatTimestamp(task.updatedAt)}
                </time>
              </dd>
            </div>
          </dl>
        </section>
      </div>

      <DialogFooter className="sm:justify-between">
        {/* Destructive action lives on the leading edge of the footer so it's
            visually separated from the benign Close / Edit affordances and
            the user is less likely to muscle-memory it. Gated on `canEdit`
            (i.e. team membership) — the DELETE endpoint 403s non-members. */}
        {canEdit ? (
          <Button
            type="button"
            variant="destructive"
            onClick={onRequestDelete}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            Delete
          </Button>
        ) : (
          // Spacer so the Close/Edit cluster stays right-aligned even when
          // the Delete affordance is hidden for non-members.
          <span aria-hidden="true" />
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:gap-2">
          <DialogClose asChild>
            <Button type="button" variant="outline" onClick={onClose}>
              Close
            </Button>
          </DialogClose>
          {canEdit ? (
            <Button type="button" onClick={onEdit}>
              <Pencil className="h-4 w-4" aria-hidden="true" />
              Edit
            </Button>
          ) : null}
        </div>
      </DialogFooter>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Edit form                                     */
/* -------------------------------------------------------------------------- */

/**
 * In-modal edit form. Replaces the read body when the user clicks Edit.
 *
 * Field rules (mirror the server-side validation in `PUT /api/tasks/[taskId]`):
 *
 *   - Title is required (non-empty after trim) and capped at 200 chars.
 *   - Description is optional, capped at 10 000 chars; an empty/whitespace
 *     value is normalized to `null` on submit so the server clears the
 *     stored description.
 *   - Assignee is optional. The native select is restricted to the team's
 *     membership list (the server otherwise returns 422 INVALID_INPUT). If
 *     the current assignee isn't in the supplied roster (e.g. the parent
 *     hasn't passed `members`), we still surface them as the selected
 *     option so a save without changes doesn't silently unassign.
 *
 * The dropdown is a native `<select>` to match the create dialog's pattern
 * (`add-task-dialog.tsx`) — there's no Radix Select primitive shipped in
 * this project yet, and a native select stays keyboard- and screen-reader-
 * accessible out of the box.
 */
function TaskDetailEditForm({
  task,
  members,
  teamId,
  saving,
  setSaving,
  onCancel,
  onSaved,
}: {
  task: TaskDetail;
  members: AddTaskTeamMember[];
  teamId?: string;
  saving: boolean;
  setSaving: (saving: boolean) => void;
  onCancel: () => void;
  onSaved: (updated: UpdatedTask) => void;
}) {
  const titleInputId = useId();
  const descriptionInputId = useId();
  const assigneeInputId = useId();
  const titleErrorId = useId();
  const descriptionErrorId = useId();
  const descriptionHintId = useId();

  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  // `null` means "Unassigned" — the AssigneeSelect handles the sentinel
  // translation internally, so this state matches the wire shape exactly.
  const [assigneeId, setAssigneeId] = useState<string | null>(
    task.assignee?.id ?? null,
  );
  const [titleError, setTitleError] = useState<string | null>(null);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);

  const trimmedTitle = useMemo(() => title.trim(), [title]);
  const trimmedTitleLength = trimmedTitle.length;
  const descriptionLength = description.length;

  // Convert the parent's team-roster shape (keyed by `userId`) into the
  // {@link AssigneeMember} shape (keyed by `id`) that the shared
  // `AssigneeSelect` consumes. Memoized so a parent re-render doesn't churn
  // the option list reference and reset the dropdown's internal focus.
  const assigneeMembers = useMemo<AssigneeMember[]>(
    () =>
      members.map((m) => ({
        id: m.userId,
        name: m.name,
        email: m.email,
      })),
    [members],
  );

  // The current saved assignee, expressed in the shape AssigneeSelect needs
  // for its "current assignee not in roster" fallback. Without this, a stale
  // roster (member removed between dialog-open and now) would visually flip
  // the trigger to "Unassigned" while `assigneeId` stayed pointed at the
  // missing user — silently misleading the next save.
  const currentAssignee = useMemo<AssigneeMember | null>(
    () =>
      task.assignee
        ? {
            id: task.assignee.id,
            name: task.assignee.name,
            email: task.assignee.email,
          }
        : null,
    [task.assignee],
  );

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (saving) return;

      // Run client-side validation first so the user sees both field errors
      // simultaneously rather than fixing one and re-submitting to discover
      // the next.
      let firstError: string | null = null;

      if (!trimmedTitle) {
        const msg = "Title is required.";
        setTitleError(msg);
        firstError = firstError ?? msg;
      } else if (trimmedTitle.length > TITLE_MAX) {
        const msg = `Title must be ${TITLE_MAX} characters or fewer.`;
        setTitleError(msg);
        firstError = firstError ?? msg;
      } else {
        setTitleError(null);
      }

      if (description.length > DESCRIPTION_MAX) {
        const msg = `Description must be ${DESCRIPTION_MAX.toLocaleString()} characters or fewer.`;
        setDescriptionError(msg);
        firstError = firstError ?? msg;
      } else {
        setDescriptionError(null);
      }

      if (firstError) return;

      // Normalize the optional fields so the wire shape matches the server
      // contract: `description` becomes null when blank/whitespace only,
      // `assigneeId` is already `string | null` thanks to the AssigneeSelect's
      // own translation of its "Unassigned" sentinel.
      const trimmedDescription = description.trim();
      const payload = {
        title: trimmedTitle,
        description: trimmedDescription === "" ? null : trimmedDescription,
        assigneeId,
      };

      setSaving(true);
      try {
        const data = await apiClient.put<UpdateTaskResponse>(
          `/api/tasks/${task.id}`,
          payload,
          { silent: true, skipAuthRedirect: true },
        );

        toast.success("Updated", {
          description: `“${data.task.title}” has been updated.`,
        });
        onSaved(data.task);
      } catch (err) {
        if (err instanceof ApiError) {
          // 422 INVALID_INPUT comes back when the assignee isn't a team
          // member (concurrent membership change between dialog-open and
          // submit). Surface the server's human-readable message rather
          // than guessing at a localized one.
          if (err.status === 422) {
            toast.error("Couldn't update task", { description: err.message });
          } else if (err.code === "INVALID_INPUT") {
            // 400 INVALID_INPUT typically means a field failed server-side
            // re-validation (e.g. unicode-only title that trims to empty).
            // Pin it to the title field — that's the most likely culprit.
            setTitleError(err.message);
            toast.error("Couldn't update task", { description: err.message });
          } else if (err.status === 404) {
            // The task was deleted out from under us. Surface a toast and
            // bail back to view-mode; the parent's load path will pick up
            // the deletion on its next refresh.
            toast.error("Task no longer exists", { description: err.message });
          } else {
            toast.error("Couldn't update task", { description: err.message });
          }
        } else {
          toast.error("Couldn't update task", {
            description: "Something went wrong. Please try again.",
          });
        }
      } finally {
        setSaving(false);
      }
    },
    [
      assigneeId,
      description,
      onSaved,
      saving,
      setSaving,
      task.id,
      trimmedTitle,
    ],
  );

  return (
    <>
      <DialogHeader>
        <DialogTitle>Edit task</DialogTitle>
        <DialogDescription>
          Update the title, description, or assignee. Changes are saved when
          you click Save.
        </DialogDescription>
      </DialogHeader>

      <form className="space-y-4" onSubmit={onSubmit} noValidate>
        {/* ---------- Title ---------- */}
        <div className="space-y-2">
          <Label htmlFor={titleInputId}>
            Title <span aria-hidden="true">*</span>
            <span className="sr-only">(required)</span>
          </Label>
          <Input
            id={titleInputId}
            name="title"
            type="text"
            autoComplete="off"
            autoFocus
            maxLength={TITLE_MAX}
            placeholder="What needs to get done?"
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              if (titleError) setTitleError(null);
            }}
            aria-invalid={Boolean(titleError)}
            aria-describedby={titleError ? titleErrorId : undefined}
            disabled={saving}
            required
          />
          <div className="flex items-center justify-end text-xs text-muted-foreground">
            <span aria-live="polite">
              {trimmedTitleLength}/{TITLE_MAX}
            </span>
          </div>
          {titleError ? (
            <p
              id={titleErrorId}
              className="text-sm text-destructive"
              role="alert"
            >
              {titleError}
            </p>
          ) : null}
        </div>

        {/* ---------- Description ---------- */}
        <div className="space-y-2">
          <Label htmlFor={descriptionInputId}>
            Description{" "}
            <span className="font-normal text-muted-foreground">
              (optional)
            </span>
          </Label>
          <Textarea
            id={descriptionInputId}
            name="description"
            maxLength={DESCRIPTION_MAX}
            placeholder="Add more context, links, acceptance criteria…"
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
              if (descriptionError) setDescriptionError(null);
            }}
            aria-invalid={Boolean(descriptionError)}
            aria-describedby={cn(
              descriptionHintId,
              descriptionError && descriptionErrorId,
            )
              .trim()
              .replace(/\s+/g, " ")}
            disabled={saving}
            rows={5}
          />
          <div
            id={descriptionHintId}
            className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
          >
            <span>Markdown supported.</span>
            <span aria-live="polite">
              {descriptionLength.toLocaleString()}/
              {DESCRIPTION_MAX.toLocaleString()}
            </span>
          </div>
          {descriptionError ? (
            <p
              id={descriptionErrorId}
              className="text-sm text-destructive"
              role="alert"
            >
              {descriptionError}
            </p>
          ) : null}
        </div>

        {/* ---------- Assignee ---------- */}
        <div className="space-y-2">
          <Label htmlFor={assigneeInputId}>
            Assignee{" "}
            <span className="font-normal text-muted-foreground">
              (optional)
            </span>
          </Label>
          {teamId ? (
            <AssigneeSelect
              id={assigneeInputId}
              teamId={teamId}
              members={assigneeMembers}
              currentAssignee={currentAssignee}
              value={assigneeId}
              onChange={setAssigneeId}
              disabled={saving}
            />
          ) : (
            // Defensive fallback: if the parent didn't pass a teamId, the
            // AssigneeSelect can't fetch on its own and we'd be stuck without
            // a roster to render. Surface a hint rather than a broken
            // dropdown — saving the form still works (the existing assignee
            // is preserved by `assigneeId` state).
            <p className="text-xs text-muted-foreground">
              Assignee picker unavailable — team context missing.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={saving || trimmedTitleLength === 0}
          >
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Saving…
              </>
            ) : (
              <>Save</>
            )}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Sub-components                                */
/* -------------------------------------------------------------------------- */

/**
 * Markdown renderer scoped to the task description. We tighten the default
 * react-markdown components so headings/links/code blocks read consistently
 * with the rest of the app. `remarkGfm` enables tables / task lists /
 * strikethrough — common in task descriptions and free to add.
 *
 * Note: `react-markdown` ≥9 disables raw HTML by default, which is exactly
 * what we want here (descriptions come from authenticated team members but
 * we still don't trust them with arbitrary HTML).
 */
function MarkdownDescription({ source }: { source: string }) {
  return (
    <div
      className={cn(
        // Plain prose-ish styling without pulling in the typography plugin —
        // just enough to make the description readable inside the modal.
        "text-sm leading-relaxed text-foreground",
        "[&>*+*]:mt-3",
        "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_a:hover]:opacity-80",
        "[&_p]:m-0",
        "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5",
        "[&_li]:mt-1",
        "[&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold",
        "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs",
        "[&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:text-xs",
        "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
        "[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
        "[&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_td]:border [&_td]:px-2 [&_td]:py-1",
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // Force any rendered link to open in a new tab so a user clicking
        // through doesn't lose the modal's surrounding context.
        components={{
          a: ({ href, children, ...rest }) => (
            <a
              {...rest}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
            >
              {children}
            </a>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

function AssigneeRow({ assignee }: { assignee: TaskDetailAssignee }) {
  const label = assignee.name ?? assignee.email;
  const initials = initialsFromAssignee(assignee);
  return (
    <div className="flex items-center gap-3">
      <Avatar className="h-9 w-9" aria-hidden="true">
        <AvatarFallback>{initials}</AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{label}</p>
        {assignee.name ? (
          <p className="truncate text-xs text-muted-foreground">
            {assignee.email}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Single attachment row.
 *
 * Rendered as an anchor pointing at `GET /api/attachments/[attachmentId]`
 * (see `app/api/attachments/[attachmentId]/route.ts`). Downloads are forced
 * server-side via a `Content-Disposition: attachment` header carrying the
 * original filename (RFC 6266 quoted-string + RFC 5987 UTF-8 extended form),
 * so the bytes always save to disk rather than rendering inline regardless
 * of the user-agent's MIME-handling defaults.
 *
 * We additionally set the HTML `download` attribute on the anchor as a
 * client-side hint:
 *
 *   - It nudges browsers that haven't parsed the response headers yet to
 *     treat the navigation as a download — a useful belt-and-braces given
 *     the link is same-origin (so the attribute is honoured without the
 *     cross-origin restriction documented on MDN).
 *   - The attribute value carries the filename so even browsers that
 *     ignore the server's `filename*=UTF-8''…` extended form still land on
 *     the original name. The server's header is the source of truth; this
 *     is a fallback.
 *
 * We deliberately drop `target="_blank"` here: combining it with the
 * `download` attribute is a known foot-gun (some browsers race the new tab
 * against the download and end up doing both), and a streamed `attachment`
 * response never replaces the current page anyway — the browser handles it
 * out-of-band — so opening a new tab buys us nothing.
 *
 * Iconography:
 *   - The leading icon is mapped from the attachment's stored MIME type via
 *     {@link iconForMimeType} (image / video / audio / archive / code /
 *     spreadsheet / json / text / generic), so the row at-a-glance hints at
 *     content shape without the user having to read the type string.
 *   - The trailing {@link Download} icon is purely an affordance hint: it
 *     reinforces that activating the row downloads bytes rather than opening
 *     a preview surface.
 */
function AttachmentRow({ attachment }: { attachment: TaskDetailAttachment }) {
  const TypeIcon = iconForMimeType(attachment.mimeType);
  return (
    <a
      href={`/api/attachments/${attachment.id}`}
      // The server's Content-Disposition is the source of truth for the
      // saved filename; `download={filename}` is the client-side fallback
      // for browsers that don't fully parse the RFC 5987 extended form.
      download={attachment.filename}
      // Same-origin link, so `noopener noreferrer` is defensive overkill —
      // but cheap, and consistent with the rest of the modal's outbound
      // anchor styling.
      rel="noopener noreferrer"
      className={cn(
        "flex items-center gap-3 px-3 py-2 text-sm",
        "transition-colors hover:bg-muted focus-visible:outline-none focus-visible:bg-muted",
      )}
      aria-label={`Download ${attachment.filename} (${formatFileSize(attachment.size)})`}
    >
      <TypeIcon
        className="h-4 w-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{attachment.filename}</p>
        <p className="truncate text-xs text-muted-foreground">
          <span className="font-mono">{attachment.mimeType}</span>
          {" · "}
          {formatFileSize(attachment.size)}
        </p>
      </div>
      <Download
        className="h-4 w-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
    </a>
  );
}

/* -------------------------------------------------------------------------- */
/*                            Loading / error states                          */
/* -------------------------------------------------------------------------- */

function TaskDetailSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <DialogHeader>
        {/* Radix requires a non-empty Title for accessibility — we render a
            visually-hidden one during loading so the dialog still announces
            a name to screen readers without showing placeholder copy. */}
        <DialogTitle className="sr-only">Loading task</DialogTitle>
        <DialogDescription className="sr-only">
          Loading task details.
        </DialogDescription>
        <div className="h-6 w-3/4 animate-pulse rounded-md bg-muted" aria-hidden="true" />
      </DialogHeader>
      <div className="space-y-3">
        <div className="h-3 w-24 animate-pulse rounded-md bg-muted" />
        <div className="h-4 w-full animate-pulse rounded-md bg-muted" />
        <div className="h-4 w-5/6 animate-pulse rounded-md bg-muted" />
        <div className="h-4 w-2/3 animate-pulse rounded-md bg-muted" />
      </div>
      <div className="space-y-3">
        <div className="h-3 w-20 animate-pulse rounded-md bg-muted" />
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 animate-pulse rounded-full bg-muted" />
          <div className="space-y-2">
            <div className="h-4 w-32 animate-pulse rounded-md bg-muted" />
            <div className="h-3 w-40 animate-pulse rounded-md bg-muted" />
          </div>
        </div>
      </div>
      <div className="space-y-3">
        <div className="h-3 w-28 animate-pulse rounded-md bg-muted" />
        <div className="h-12 w-full animate-pulse rounded-md bg-muted" />
      </div>
      <span className="sr-only">Loading task…</span>
    </div>
  );
}

function TaskDetailErrorState({
  message,
  onRetry,
  onClose,
}: {
  message: string;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Couldn&apos;t load task</DialogTitle>
        <DialogDescription>
          We hit a snag fetching this task. You can retry, or close and try
          again later.
        </DialogDescription>
      </DialogHeader>
      <div
        role="alert"
        className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
      >
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{message}</span>
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
        <Button type="button" onClick={onRetry}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Retry
        </Button>
      </div>
    </>
  );
}

function TaskDetailNotFoundState({ onClose }: { onClose: () => void }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Task not found</DialogTitle>
        <DialogDescription>
          This task has been deleted or you no longer have access to it.
        </DialogDescription>
      </DialogHeader>
      <div className="flex justify-end pt-2">
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
    </>
  );
}

function TaskDetailForbiddenState({ onClose }: { onClose: () => void }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>You don&apos;t have access</DialogTitle>
        <DialogDescription>
          This task is part of a private project. Ask a team admin to add you
          as a member.
        </DialogDescription>
      </DialogHeader>
      <div className="flex justify-end pt-2">
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
    </>
  );
}
