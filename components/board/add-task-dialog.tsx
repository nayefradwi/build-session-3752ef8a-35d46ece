"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { ApiError, apiClient } from "@/lib/client/api-client";
import { cn } from "@/lib/client/utils";
import { AssigneeSelect, type AssigneeMember } from "@/components/board/assignee-select";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MarkdownEditor } from "@/components/board/markdown-editor";
import type { BoardTask, BoardTaskAssignee } from "@/components/board/types";

/* -------------------------------------------------------------------------- */
/*                                API contract                                */
/* -------------------------------------------------------------------------- */

/**
 * Mirrors the server-side validation in `POST /api/projects/[projectId]/tasks`.
 * Keep these in sync — the client cap mirrors the route handler so the user
 * gets immediate feedback before a 400 round-trip.
 */
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 10_000;

/** Mirrors the response body of `POST /api/projects/[projectId]/tasks`. */
type CreatedTask = {
  id: string;
  columnId: string;
  title: string;
  description: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
  assignee: BoardTaskAssignee | null;
};
type CreateTaskResponse = { task: CreatedTask };

/** Slice of a team member needed to populate the assignee dropdown. */
export type AddTaskTeamMember = {
  userId: string;
  name: string | null;
  email: string;
};

/* -------------------------------------------------------------------------- */
/*                                  Component                                 */
/* -------------------------------------------------------------------------- */

export type AddTaskDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolved project id — required to know which board to POST against. */
  projectId: string;
  /** Owning team id — forwarded to the {@link AssigneeSelect} so it can
   *  fall back to fetching `/api/teams/[teamId]/members` if the parent
   *  hasn't preloaded a roster. */
  teamId: string;
  /** Column the task is being added to. The submit POSTs `{ columnId }` so
   *  the server can scope the position lookup + lock to the right lane. */
  columnId: string;
  /** Display name of the column shown in the dialog copy so the user knows
   *  which lane they're adding into. */
  columnName: string;
  /** Team members surfaced in the assignee dropdown. The server enforces
   *  the same gate (assignee must be a team member), so we present exactly
   *  the same allowed set here. */
  members: AddTaskTeamMember[];
  /**
   * Called with the freshly-created task on success. The caller is expected
   * to append it to its local column state so the new card shows up without
   * a full board refetch.
   */
  onCreated: (task: BoardTask) => void;
};

/**
 * "Add task" dialog launched from the trailing affordance in each kanban
 * column. Mirrors the structure of {@link import("./add-column-dialog").AddColumnDialog}
 * (single form, sonner toasts, dialog close on success) so the two surfaces
 * feel consistent.
 *
 *   - Title is required and clamped to 200 chars; we bounce validation
 *     client-side before hitting the API so the user gets immediate feedback.
 *   - Description is optional, markdown-friendly (the task-detail surface
 *     will render it later); we surface a small hint under the textarea so
 *     the affordance is discoverable without a help link.
 *   - Assignee dropdown is a native `<select>` populated from the team's
 *     membership list. Native is intentional — there's no Radix Select in
 *     the project yet, and a native select stays keyboard- and screen-
 *     reader-accessible out of the box (matches the role-select pattern in
 *     `team-members-manager.tsx`).
 *   - The dialog can't be dismissed while a submission is in flight: we'd
 *     otherwise lose the result of an already-in-flight POST.
 *   - Reset transient form state every time the dialog closes so the next
 *     open is clean — without this, an aborted submit would re-show stale
 *     errors on next open.
 */
export function AddTaskDialog({
  open,
  onOpenChange,
  projectId,
  teamId,
  columnId,
  columnName,
  members,
  onCreated,
}: AddTaskDialogProps) {
  const titleInputId = useId();
  const descriptionInputId = useId();
  const assigneeInputId = useId();
  const titleErrorId = useId();
  const descriptionErrorId = useId();
  const descriptionHintId = useId();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  // `null` means "Unassigned" — the AssigneeSelect handles the sentinel
  // translation internally, so we only ever store the real wire shape here.
  const [assigneeId, setAssigneeId] = useState<string | null>(null);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setTitle("");
      setDescription("");
      setAssigneeId(null);
      setTitleError(null);
      setDescriptionError(null);
      setSubmitting(false);
    }
  }, [open]);

  // If the column the dialog targets changes mid-life (e.g. a different lane
  // is opened without the dialog closing first — currently the parent always
  // closes before reopening, but this keeps the state coherent), reset the
  // selected assignee to "unassigned" so we don't carry over a pick that
  // belonged to a different context.
  useEffect(() => {
    if (open) setAssigneeId(null);
  }, [columnId, open]);

  const trimmedTitle = useMemo(() => title.trim(), [title]);
  const trimmedTitleLength = trimmedTitle.length;
  const descriptionLength = description.length;

  // Convert the parent's team-roster shape (keyed by `userId`) into the
  // {@link AssigneeMember} shape (keyed by `id`) that the shared
  // `AssigneeSelect` expects. Memoized so a cosmetic re-render of the parent
  // doesn't churn the option list reference.
  const assigneeMembers = useMemo<AssigneeMember[]>(
    () =>
      members.map((m) => ({
        id: m.userId,
        name: m.name,
        email: m.email,
      })),
    [members],
  );

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submitting) return;

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
        columnId,
        title: trimmedTitle,
        description: trimmedDescription === "" ? null : trimmedDescription,
        assigneeId,
      };

      setSubmitting(true);
      try {
        const data = await apiClient.post<CreateTaskResponse>(
          `/api/projects/${projectId}/tasks`,
          payload,
          { silent: true, skipAuthRedirect: true },
        );

        // The server returns the inflated task with timestamps + assignee
        // slice. We pass on only the fields the board's local model cares
        // about (BoardTask) — the timestamps are unused on the card today,
        // but a follow-up surface (task detail) can refetch.
        const task: BoardTask = {
          id: data.task.id,
          columnId: data.task.columnId,
          title: data.task.title,
          description: data.task.description,
          position: data.task.position,
          assignee: data.task.assignee,
        };

        toast.success("Task added", {
          description: `“${data.task.title}” is on the board.`,
        });
        onCreated(task);
        onOpenChange(false);
      } catch (err) {
        if (err instanceof ApiError) {
          // 422 INVALID_INPUT comes back when the assignee isn't a team
          // member or the columnId belongs to a different project. The
          // assignee dropdown only ever offers team members, but a stale
          // membership (member removed in another tab between dialog-open
          // and submit) can still produce this. Surface the server's
          // human-readable message rather than guessing at a localized one.
          if (err.status === 422) {
            toast.error("Couldn't add task", { description: err.message });
          } else if (err.code === "INVALID_INPUT") {
            // 400 INVALID_INPUT typically means a field failed server-side
            // re-validation (e.g. unicode-only title that trims to empty).
            // Pin it to the title field — that's the most likely culprit.
            setTitleError(err.message);
            toast.error("Couldn't add task", { description: err.message });
          } else {
            toast.error("Couldn't add task", { description: err.message });
          }
        } else {
          toast.error("Couldn't add task", {
            description: "Something went wrong. Please try again.",
          });
        }
      } finally {
        setSubmitting(false);
      }
    },
    [
      assigneeId,
      columnId,
      description,
      onCreated,
      onOpenChange,
      projectId,
      submitting,
      trimmedTitle,
    ],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (submitting && !next) return;
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a task</DialogTitle>
          <DialogDescription>
            New task in{" "}
            <span className="font-medium text-foreground">{columnName}</span>.
            Tasks are appended to the end of the column.
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
              disabled={submitting}
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
            <MarkdownEditor
              id={descriptionInputId}
              name="description"
              value={description}
              onChange={(next) => {
                setDescription(next);
                if (descriptionError) setDescriptionError(null);
              }}
              placeholder="Add more context, links, acceptance criteria…"
              maxLength={DESCRIPTION_MAX}
              rows={4}
              disabled={submitting}
              aria-invalid={Boolean(descriptionError)}
              aria-describedby={cn(
                descriptionHintId,
                descriptionError && descriptionErrorId,
              )
                .trim()
                .replace(/\s+/g, " ")}
            />
            <div
              id={descriptionHintId}
              className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
            >
              <span>Markdown supported — switch to Preview to see the rendered output.</span>
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
            <AssigneeSelect
              id={assigneeInputId}
              teamId={teamId}
              members={assigneeMembers}
              value={assigneeId}
              onChange={setAssigneeId}
              disabled={submitting}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={submitting || trimmedTitleLength === 0}
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Adding…
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  Add task
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
