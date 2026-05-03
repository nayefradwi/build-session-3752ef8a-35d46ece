"use client";

import { useEffect, useState } from "react";
import {
  AlertCircle,
  CalendarClock,
  CalendarPlus,
  Download,
  FileText,
  Paperclip,
  RefreshCw,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { ApiError, apiClient } from "@/lib/client/api-client";
import { cn } from "@/lib/client/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/* -------------------------------------------------------------------------- */
/*                                API contract                                */
/* -------------------------------------------------------------------------- */

/**
 * Mirrors the response of `GET /api/tasks/[taskId]`.
 *
 * The handler inlines an `assignee` slice (`{ id, name, email }`) when one is
 * set — `null` otherwise — and ships an `attachments` array. The attachments
 * field is reserved on the wire and currently always empty (the storage
 * driver hasn't been wired up to expose it on this read path yet), but we
 * type the shape now so the modal renders the list as soon as the route
 * starts populating it without any client-side change.
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
};

/**
 * Detail view for a single task, opened from a card click on the kanban
 * board. Driven entirely by `GET /api/tasks/[taskId]` — this surface owns
 * the read, so the parent only has to hand us the id.
 *
 *   - While the request is in flight, renders a skeleton placeholder so the
 *     dialog content area doesn't reflow when data lands.
 *   - On success, renders the title, the markdown-rendered description,
 *     assignee identity, attachments (with download links), and the
 *     created/updated timestamps.
 *   - On error, renders an alert with a Retry button so a transient network
 *     blip doesn't force the user to close + reopen.
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
 *     button (see `components/ui/dialog.tsx`); we add an explicit footer
 *     "Close" button for keyboard/touch parity, satisfying the spec's
 *     "include a close button" requirement.
 */
export function TaskDetailModal({
  open,
  onOpenChange,
  taskId,
}: TaskDetailModalProps) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  // Bumped to force a refetch from the Retry button without changing taskId.
  const [retryCounter, setRetryCounter] = useState(0);

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
          <TaskDetailBody
            task={task}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Detail body                                   */
/* -------------------------------------------------------------------------- */

function TaskDetailBody({
  task,
  onClose,
}: {
  task: TaskDetail;
  onClose: () => void;
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

      <div className="flex justify-end pt-2">
        <DialogClose asChild>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogClose>
      </div>
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
 * The wire shape includes id, filename, mimeType, size, and createdAt — but
 * not a URL: the API has not yet exposed a download endpoint for attachments
 * (the GET handler hard-codes an empty list as of this writing). To keep the
 * UI ready for the day the route lights up, we render the row as an anchor
 * pointing at the conventional location (`/api/attachments/[id]`); the
 * attribute is harmless until the route exists since the list itself stays
 * empty in production.
 */
function AttachmentRow({ attachment }: { attachment: TaskDetailAttachment }) {
  return (
    <a
      href={`/api/attachments/${attachment.id}`}
      // We don't know the storage backend's response shape yet, so let the
      // browser handle the redirect/download natively without forcing a
      // download attribute (which can fight signed-URL redirects).
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "flex items-center gap-3 px-3 py-2 text-sm",
        "transition-colors hover:bg-muted focus-visible:outline-none focus-visible:bg-muted",
      )}
      aria-label={`Download ${attachment.filename}`}
    >
      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{attachment.filename}</p>
        <p className="truncate text-xs text-muted-foreground">
          {attachment.mimeType} · {formatFileSize(attachment.size)}
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
