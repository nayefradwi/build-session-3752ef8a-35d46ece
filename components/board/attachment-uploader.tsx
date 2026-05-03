"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { Loader2, Upload, X } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/client/utils";
import { Button } from "@/components/ui/button";

/* -------------------------------------------------------------------------- */
/*                              Shared constants                              */
/* -------------------------------------------------------------------------- */

/**
 * Mirror of `lib/server/uploads/validation.ts`. The server side lives behind
 * `import "server-only"` so we can't pull from it here — but the values are
 * the contract, and copy-pasting once is cheap. If you bump these on the
 * server, bump them here too so the client gives immediate feedback rather
 * than burning a 10 MiB upload on a guaranteed 422.
 */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Hard cap on attachments-per-task. Mirrors `MAX_ATTACHMENTS_PER_TASK` in
 * `app/api/tasks/[taskId]/attachments/route.ts`. The UI hides / disables the
 * upload affordance past this count so the user doesn't pick a file only to
 * eat a 422 LIMIT_REACHED — the server is still authoritative (concurrent
 * uploads from a peer could push us over between renders), but a clean
 * happy-path UX wins here.
 */
export const ATTACHMENT_MAX_PER_TASK = 10;

/**
 * Whitelist of MIME types the upload endpoint accepts. Same list as
 * `ALLOWED_MIME_TYPES` on the server. We use it for two things:
 *
 *   1. The hidden `<input>`'s `accept=` attribute, which steers the OS file
 *      picker but is NOT a security boundary (the user can override it).
 *   2. A pre-flight reject toast on file selection, so a `.docx` is caught
 *      before we POST it. The server still re-validates — see the route.
 */
export const ATTACHMENT_ALLOWED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
] as const;

/** Comma-joined `accept=` value for the hidden file input. */
const ACCEPT_ATTRIBUTE = ATTACHMENT_ALLOWED_MIME_TYPES.join(",");

/* -------------------------------------------------------------------------- */
/*                                Wire shape                                  */
/* -------------------------------------------------------------------------- */

/**
 * Wire shape of the `attachment` slice returned by
 * `POST /api/tasks/[taskId]/attachments`. The server returns `Date` for
 * `createdAt` which serializes to an ISO-8601 string on the wire — we type
 * it as `string` here because client code only ever reads it post-JSON-parse.
 */
export type UploadedAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
};

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

/**
 * Render N MiB to one decimal place — matches the granularity the modal's
 * existing `formatFileSize` helper uses for the attachment row.
 */
const formatFileSizeMiB = (bytes: number): string =>
  `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** Ceiling of N MiB as an integer — used in copy ("the 10 MB limit"). */
const formatLimitMiB = (bytes: number): string =>
  `${Math.floor(bytes / (1024 * 1024))} MB`;

/* -------------------------------------------------------------------------- */
/*                                Component                                   */
/* -------------------------------------------------------------------------- */

export type AttachmentUploaderProps = {
  /** Task to upload against. POSTed at `/api/tasks/{taskId}/attachments`. */
  taskId: string;
  /**
   * Current number of attachments on the task. Drives the count-cap gate —
   * past {@link ATTACHMENT_MAX_PER_TASK} we disable the trigger and surface
   * a hint so the user understands why.
   */
  count: number;
  /**
   * When true, the affordance is hidden entirely (e.g. caller is not a team
   * member of the owning team — the POST endpoint 403s anyway, so showing
   * the button would lure them into a guaranteed failure).
   */
  disabled?: boolean;
  /**
   * Called with the freshly-uploaded attachment payload. The parent is
   * expected to splice it into the displayed list so the new row renders
   * without a full task refetch.
   */
  onUploaded: (attachment: UploadedAttachment) => void;
};

/**
 * Upload control for the task-detail attachments section.
 *
 * Why XHR (not fetch)? `fetch()` has no cross-browser hook for upload-byte
 * progress — the request body is consumed opaquely. `XMLHttpRequest.upload`
 * exposes a real `progress` event with `loaded` / `total`, which is what we
 * need to drive the inline progress bar. We could fetch+ReadableStream the
 * *response* for download progress, but that's the wrong direction here.
 *
 * Validation strategy:
 *   - Size, count, and MIME type are checked client-side BEFORE we POST so
 *     a doomed upload doesn't burn bandwidth + time. Each violation surfaces
 *     a `toast.error` with copy that explains the limit.
 *   - The server re-validates everything; we trust its codes
 *     (LIMIT_REACHED → 422, UNSUPPORTED_MEDIA_TYPE → 415, etc.) and surface
 *     them as toasts when they slip past the client check (e.g. a peer
 *     concurrently filled the 10th slot between renders).
 *
 * Lifecycle:
 *   - One upload at a time. While `uploading` is true, the trigger is
 *     disabled and a Cancel control surfaces the inline xhr.abort().
 *   - On unmount we abort any in-flight XHR so a closed-mid-upload modal
 *     doesn't leak a pending request — the server-side write is in a tx so
 *     an abort cancels the row insert cleanly.
 */
export function AttachmentUploader({
  taskId,
  count,
  disabled = false,
  onUploaded,
}: AttachmentUploaderProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Holds the in-flight XHR so we can `.abort()` from the Cancel button or
  // on unmount. `null` whenever no upload is active.
  const xhrRef = useRef<XMLHttpRequest | null>(null);

  const [uploading, setUploading] = useState(false);
  // 0..100. We set to 100 explicitly on `xhr.upload.onload` (all bytes
  // flushed) so the bar fills while we wait on the server response, rather
  // than appearing stuck at 99%.
  const [progress, setProgress] = useState(0);
  const [currentName, setCurrentName] = useState<string | null>(null);

  const remaining = ATTACHMENT_MAX_PER_TASK - count;
  const atLimit = remaining <= 0;
  const triggerDisabled = disabled || uploading || atLimit;

  // Cleanup: abort any in-flight upload on unmount. Without this, closing
  // the modal mid-upload would leak the request — the server would still
  // consume the body and write the row, while the UI's reference is gone.
  useEffect(() => {
    return () => {
      const xhr = xhrRef.current;
      if (xhr && xhr.readyState !== XMLHttpRequest.DONE) {
        xhr.abort();
      }
      xhrRef.current = null;
    };
  }, []);

  const reset = useCallback(() => {
    setUploading(false);
    setProgress(0);
    setCurrentName(null);
    // Clear the input value so the SAME file can be re-selected (the change
    // event doesn't fire if `files[0]` is identical to the previous pick).
    if (inputRef.current) inputRef.current.value = "";
    xhrRef.current = null;
  }, []);

  const handleTriggerClick = useCallback(() => {
    if (triggerDisabled) return;
    inputRef.current?.click();
  }, [triggerDisabled]);

  const handleCancel = useCallback(() => {
    const xhr = xhrRef.current;
    if (xhr && xhr.readyState !== XMLHttpRequest.DONE) {
      xhr.abort();
    }
    // The `onabort` handler also calls reset(); calling it here too is
    // idempotent (boolean flips, value clears) and covers the "abort fired
    // synchronously before the DOM event loop ticks" path.
    reset();
  }, [reset]);

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // No file picked (the user opened the picker and cancelled) — bail
      // without churning state.
      if (!file) return;

      /* ------- Pre-flight client-side validation ------- */

      // Recheck the count cap here as well as on the trigger — a peer
      // upload could have landed between the click and the picker close.
      if (count >= ATTACHMENT_MAX_PER_TASK) {
        toast.error("Attachment limit reached", {
          description: `Tasks are limited to ${ATTACHMENT_MAX_PER_TASK} attachments. Delete one before uploading another.`,
        });
        if (inputRef.current) inputRef.current.value = "";
        return;
      }

      if (file.size <= 0) {
        toast.error("Couldn’t upload", {
          description: `“${file.name}” is empty.`,
        });
        if (inputRef.current) inputRef.current.value = "";
        return;
      }

      if (file.size > ATTACHMENT_MAX_BYTES) {
        toast.error("File too large", {
          description: `“${file.name}” is ${formatFileSizeMiB(
            file.size,
          )}. The upload limit is ${formatLimitMiB(ATTACHMENT_MAX_BYTES)}.`,
        });
        if (inputRef.current) inputRef.current.value = "";
        return;
      }

      const mime = (file.type ?? "").toLowerCase().trim();
      if (
        !mime ||
        !(ATTACHMENT_ALLOWED_MIME_TYPES as readonly string[]).includes(mime)
      ) {
        toast.error("Unsupported file type", {
          description: mime
            ? `“${file.name}” has type ${mime}. Try PNG, JPEG, GIF, WebP, SVG, PDF, plain text, CSV, Markdown, or JSON.`
            : `Couldn’t determine the file type of “${file.name}”. Try PNG, JPEG, GIF, WebP, SVG, PDF, plain text, CSV, Markdown, or JSON.`,
        });
        if (inputRef.current) inputRef.current.value = "";
        return;
      }

      /* ------- Build & send the upload ------- */

      const form = new FormData();
      form.append("file", file);

      const xhr = new XMLHttpRequest();
      xhrRef.current = xhr;
      setUploading(true);
      setProgress(0);
      setCurrentName(file.name);

      // Upload byte progress — only fires while we're flushing the request
      // body. Doesn't fire for the response leg; we top out at 100 on
      // `upload.onload` (all bytes sent, awaiting response).
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pct = Math.min(99, Math.round((e.loaded / e.total) * 100));
        setProgress(pct);
      };
      xhr.upload.onload = () => {
        // Bytes are out the door — pin the bar at 100 so the loading copy
        // visibly switches from "uploading" to "processing on the server".
        setProgress(100);
      };

      xhr.onerror = () => {
        toast.error("Upload failed", {
          description:
            "A network error interrupted the upload. Check your connection and try again.",
        });
        reset();
      };

      xhr.onabort = () => {
        // User-cancelled or unmount — silent reset; no toast.
        reset();
      };

      xhr.onload = () => {
        const status = xhr.status;
        // Best-effort JSON parse — the route always responds JSON, but a
        // proxy / outage could send back HTML; never assume.
        let parsed: unknown = undefined;
        try {
          parsed = xhr.responseText ? JSON.parse(xhr.responseText) : undefined;
        } catch {
          parsed = undefined;
        }

        if (status >= 200 && status < 300) {
          const body = parsed as
            | { attachment?: UploadedAttachment & { taskId?: string } }
            | undefined;
          const att = body?.attachment;
          if (att && typeof att.id === "string" && typeof att.filename === "string") {
            // Coerce createdAt defensively. The server returns Date which
            // JSON.stringify turns into an ISO string, but we coerce in
            // case a future server change hands us a number/Date.
            const createdAt =
              typeof att.createdAt === "string"
                ? att.createdAt
                : new Date(att.createdAt as unknown as number | Date | string).toISOString();
            const normalized: UploadedAttachment = {
              id: att.id,
              filename: att.filename,
              mimeType: att.mimeType,
              size: att.size,
              createdAt,
            };
            toast.success("Attachment uploaded", {
              description: normalized.filename,
            });
            onUploaded(normalized);
            reset();
            return;
          }
          // 2xx but the body shape is wrong — surface a generic toast and
          // bail rather than silently strand the user.
          toast.error("Couldn’t upload", {
            description: "The server response was malformed. Please try again.",
          });
          reset();
          return;
        }

        const data = parsed as
          | { error?: string; message?: string; code?: string }
          | undefined;
        const message =
          data?.error ?? data?.message ?? "Couldn’t upload that file.";
        const code = data?.code;

        // Map the route's error codes onto user-facing toasts. The size +
        // count violations get specialized titles per the task spec; the
        // rest fall through to a generic "Couldn’t upload" with the
        // server's message as the description.
        if (status === 422 && code === "LIMIT_REACHED") {
          // Same code covers BOTH "10 attachments already" and "this file
          // exceeds 10 MB" — the route uses LIMIT_REACHED for both. Pick
          // the title from the message wording.
          const isSize = /\bMB\b|exceeds/i.test(message);
          toast.error(isSize ? "File too large" : "Attachment limit reached", {
            description: message,
          });
        } else if (status === 415) {
          toast.error("Unsupported file type", { description: message });
        } else if (status === 413) {
          toast.error("File too large", { description: message });
        } else if (status === 422) {
          toast.error("Couldn’t upload", { description: message });
        } else if (status === 403) {
          toast.error("Couldn’t upload", { description: message });
        } else if (status === 404) {
          toast.error("Task no longer exists", { description: message });
        } else if (status === 401) {
          toast.error("Session expired", {
            description: "Please sign in again to continue.",
          });
        } else {
          toast.error("Couldn’t upload", { description: message });
        }
        reset();
      };

      xhr.open("POST", `/api/tasks/${taskId}/attachments`);
      // IMPORTANT: do NOT set Content-Type. XHR populates it with the
      // generated multipart boundary when sending FormData; an explicit
      // header would override the boundary parameter and corrupt the body.
      xhr.send(form);
    },
    [count, onUploaded, reset, taskId],
  );

  // The whole component collapses to nothing for non-members — the POST
  // endpoint 403s them anyway and the affordance would just be a tease.
  if (disabled) return null;

  return (
    <div className="space-y-2">
      {/* Hidden file input — visually removed but kept in the DOM (rather
          than rendered conditionally) so the ref stays stable across
          uploads. The `accept=` steers the OS picker to the allowed types
          but is NOT a security boundary. */}
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept={ACCEPT_ATTRIBUTE}
        className="sr-only"
        // Disable while an upload is in flight so the user can't fire a
        // second pick mid-flight.
        disabled={uploading}
        onChange={handleChange}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleTriggerClick}
          disabled={triggerDisabled}
          // Surface the trigger to the hidden input via aria so the label
          // / button relationship is announced.
          aria-controls={inputId}
        >
          {uploading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Uploading…
            </>
          ) : (
            <>
              <Upload className="h-4 w-4" aria-hidden="true" />
              Upload attachment
            </>
          )}
        </Button>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {atLimit
            ? `${ATTACHMENT_MAX_PER_TASK} of ${ATTACHMENT_MAX_PER_TASK} — limit reached`
            : `${count} of ${ATTACHMENT_MAX_PER_TASK} attachments`}
        </span>
      </div>

      {/* Progress affordance. Renders only while an upload is active — we
          don't keep a "100% — done" state because the success toast is the
          terminal feedback. */}
      {uploading ? (
        <div
          className={cn(
            "rounded-md border bg-muted/40 px-3 py-2",
            "flex items-center gap-3 text-xs text-muted-foreground",
          )}
          role="status"
          aria-live="polite"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-foreground">
              {currentName ?? "Uploading…"}
            </p>
            <div
              className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
              aria-label={`Uploading ${currentName ?? "file"}`}
            >
              <div
                className="h-full bg-primary transition-[width] duration-150"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="mt-1 tabular-nums">
              {progress < 100 ? `${progress}%` : "Finalizing…"}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleCancel}
            aria-label="Cancel upload"
          >
            <X className="h-4 w-4" aria-hidden="true" />
            Cancel
          </Button>
        </div>
      ) : null}

      {!atLimit ? (
        <p className="text-xs text-muted-foreground">
          Up to {formatLimitMiB(ATTACHMENT_MAX_BYTES)} per file. Images, PDFs,
          and plain-text formats supported.
        </p>
      ) : null}
    </div>
  );
}
