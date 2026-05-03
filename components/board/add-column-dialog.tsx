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

/* -------------------------------------------------------------------------- */
/*                                API contract                                */
/* -------------------------------------------------------------------------- */

/**
 * Mirrors the server-side validation in `POST /api/projects/[projectId]/columns`.
 * Keep these in sync — the client cap mirrors the route handler so the user
 * gets immediate feedback before a 400 round-trip.
 */
const COLUMN_NAME_MAX = 120;

/** Mirrors the response body of `POST /api/projects/[projectId]/columns`. */
type CreatedColumn = {
  id: string;
  projectId: string;
  name: string;
  position: number;
};
type CreateColumnResponse = { column: CreatedColumn };

/* -------------------------------------------------------------------------- */
/*                                  Component                                 */
/* -------------------------------------------------------------------------- */

export type AddColumnDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolved project id — required to know which board to POST against. */
  projectId: string;
  /**
   * Called with the newly created column on success. The caller is expected to
   * append the column to its local board state so the new lane shows up
   * without a full board refetch.
   */
  onCreated: (column: CreatedColumn) => void;
};

/**
 * "Add column" dialog for the kanban board. Mirrors the structure of the
 * "Create team" dialog (single name input, sonner toasts, dialog close on
 * success) so the two surfaces feel consistent.
 *
 *   - Server enforces a 10-column hard cap; on 422 `LIMIT_REACHED` we surface
 *     a targeted toast pointing the admin at the existing lanes rather than
 *     repeating the generic "Couldn't create column" copy.
 *   - The dialog can't be dismissed while a submission is in flight: we'd
 *     otherwise lose the result of an already-in-flight POST.
 *   - Reset transient form state every time the dialog closes so the next
 *     open is clean — without this, an aborted submit would re-show the
 *     previous error on next open.
 */
export function AddColumnDialog({
  open,
  onOpenChange,
  projectId,
  onCreated,
}: AddColumnDialogProps) {
  const nameInputId = useId();
  const errorId = useId();

  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setName("");
      setNameError(null);
      setSubmitting(false);
    }
  }, [open]);

  const trimmedLength = useMemo(() => name.trim().length, [name]);

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submitting) return;

      const trimmed = name.trim();
      if (!trimmed) {
        setNameError("Column name is required.");
        return;
      }
      if (trimmed.length > COLUMN_NAME_MAX) {
        setNameError(
          `Column name must be ${COLUMN_NAME_MAX} characters or fewer.`,
        );
        return;
      }
      setNameError(null);
      setSubmitting(true);

      try {
        const data = await apiClient.post<CreateColumnResponse>(
          `/api/projects/${projectId}/columns`,
          { name: trimmed },
          { silent: true, skipAuthRedirect: true },
        );

        toast.success("Column added", {
          description: `${data.column.name} is ready for tasks.`,
        });
        onCreated(data.column);
        onOpenChange(false);
      } catch (err) {
        // 422 LIMIT_REACHED: the project already has the maximum 10 columns.
        // Show a dedicated toast (and clear the inline error so the dialog
        // doesn't double-surface the message) — the limit is a board-level
        // constraint, not a name validation issue.
        if (err instanceof ApiError && err.code === "LIMIT_REACHED") {
          toast.error("Column limit reached", {
            description:
              "A board can hold up to 10 columns. Remove an existing column before adding another.",
          });
          setNameError(null);
        } else if (err instanceof ApiError) {
          // 400 INVALID_INPUT typically means name validation failed server-
          // side (e.g. a unicode-only string that trims to empty); surface it
          // inline so the user can correct the field.
          if (err.code === "INVALID_INPUT") {
            setNameError(err.message);
          }
          toast.error("Couldn't add column", { description: err.message });
        } else {
          toast.error("Couldn't add column", {
            description: "Something went wrong. Please try again.",
          });
        }
      } finally {
        setSubmitting(false);
      }
    },
    [name, onCreated, onOpenChange, projectId, submitting],
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
          <DialogTitle>Add a column</DialogTitle>
          <DialogDescription>
            Columns are kanban lanes — typically a workflow stage like “To do”,
            “In progress” or “Done”. New columns are appended to the end of the
            board.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={onSubmit} noValidate>
          <div className="space-y-2">
            <Label htmlFor={nameInputId}>Column name</Label>
            <Input
              id={nameInputId}
              name="name"
              type="text"
              autoComplete="off"
              autoFocus
              maxLength={COLUMN_NAME_MAX}
              placeholder="To do, In progress, Done…"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                if (nameError) setNameError(null);
              }}
              aria-invalid={Boolean(nameError)}
              aria-describedby={nameError ? errorId : undefined}
              disabled={submitting}
              required
            />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Up to 10 columns per board.</span>
              <span aria-live="polite">
                {trimmedLength}/{COLUMN_NAME_MAX}
              </span>
            </div>
            {nameError ? (
              <p id={errorId} className="text-sm text-destructive" role="alert">
                {nameError}
              </p>
            ) : null}
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
            <Button type="submit" disabled={submitting || trimmedLength === 0}>
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Adding…
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  Add column
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
