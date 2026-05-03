import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { attachments, columns, tasks } from "@/lib/db/schema";
import { auth } from "@/lib/server/auth";
import { resolveProjectAccessByProjectId } from "@/lib/server/projects/access";
import {
  ensureUploadDir,
  getUploadDir,
  uploadBootstrapFailed,
  validateUpload,
} from "@/lib/server/uploads";

// Force dynamic: every upload pulls the session cookie and writes a brand-new
// row + on-disk file. Nothing about this is cacheable.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type AttachmentErrorCode =
  | "INVALID_INPUT"
  | "INVALID_BODY"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "LIMIT_REACHED"
  | "INTERNAL_ERROR";

const errorResponse = (
  status: number,
  code: AttachmentErrorCode,
  message: string,
  details?: unknown,
): NextResponse =>
  NextResponse.json(
    details === undefined
      ? { error: message, code }
      : { error: message, code, details },
    { status },
  );

// taskId is a dynamic segment; validate as a UUID before we hit Postgres so
// the uuid-cast in the WHERE clause never panics with a 500.
const taskIdParamSchema = z.uuid();

/**
 * Hard cap on attachments-per-task. Matches the kanban-card UX: above ten
 * the per-card list becomes a scroll soup and signals the user is using
 * attachments for what should be a folder share. The check runs under a
 * task-row lock inside the create tx, so two concurrent uploads can't both
 * slip through at count = 9.
 */
const MAX_ATTACHMENTS_PER_TASK = 10;

/**
 * Sanitize the user-supplied filename for on-disk storage.
 *
 * Multipart `File.name` is fully attacker-controlled — it can contain path
 * separators ("../etc/passwd"), NUL bytes, or be empty. We:
 *   1. Strip any leading directory components via `path.basename` (the POSIX
 *      and win32 variants both look for "/" but win32 also handles "\").
 *      Run win32 first, then posix, to defang both.
 *   2. Drop control characters (NUL, etc.) and the few characters that cause
 *      grief on Windows / S3 / common shells: `\ / : * ? " < > |`. Replace
 *      with "_" rather than dropping so the visible filename stays roughly
 *      the same length.
 *   3. Collapse runs of whitespace to a single space, then trim.
 *   4. Truncate to 200 chars (preserving the extension if reasonable). 200 is
 *      well below NAME_MAX on every common FS (255) and leaves headroom for
 *      the "<uuid>-" prefix.
 *   5. Fall back to "file" if the result is empty after sanitization — the
 *      filename column is NOT NULL, and "file" is a sane default the UI can
 *      still display.
 *
 * The UUID prefix on the on-disk path means collisions are impossible even
 * if two users upload the same name to the same task.
 */
function sanitizeFilename(rawName: string): string {
  // Strip directory traversal: handle both win32 and posix separators.
  const basenameWin = path.win32.basename(rawName);
  const basename = path.posix.basename(basenameWin);

  // Replace problematic characters. \x00-\x1F covers the C0 control range
  // (incl. NUL); the literal set is the "reserved on common filesystems"
  // group.
  // eslint-disable-next-line no-control-regex
  const replaced = basename.replace(/[\x00-\x1F\\/:*?"<>|]/g, "_");

  // Collapse whitespace runs.
  const collapsed = replaced.replace(/\s+/g, " ").trim();

  if (collapsed.length === 0) return "file";

  if (collapsed.length <= 200) return collapsed;

  // Preserve the extension when truncating so .png stays a .png on disk.
  const ext = path.extname(collapsed);
  if (ext.length > 0 && ext.length < 16) {
    const stem = collapsed.slice(0, 200 - ext.length);
    return `${stem}${ext}`;
  }
  return collapsed.slice(0, 200);
}

/**
 * POST /api/tasks/[taskId]/attachments
 *
 * Upload an attachment to a task. Accepts `multipart/form-data` with a single
 * `file` part. Validates size, type, and the per-task attachment cap before
 * touching the filesystem; writes to `<UPLOAD_DIR>/<taskId>/<uuid>-<filename>`
 * and inserts a matching row into the `attachments` table.
 *
 * Authorization (mirrors the task write endpoints):
 *   - Caller must be authenticated (401 otherwise).
 *   - The task's owning project must live in the caller's tenant. Cross-tenant
 *     or non-existent task ids collapse to 404 to avoid leaking existence.
 *   - Caller must be a *team member* of the owning team. Public-project
 *     visibility lets non-members read tasks, but uploads — like every other
 *     write — require team membership; non-members get 403.
 *
 * Validation:
 *   - `file` part must be present (400 INVALID_BODY otherwise).
 *   - File must have a non-empty name and non-zero size (422).
 *   - File must be ≤ 10 MiB (422 LIMIT_REACHED — the task spec maps size
 *     overflow to 422 even though 413 would be the strict-HTTP read).
 *   - MIME type must be in the shared whitelist (415 UNSUPPORTED_MEDIA_TYPE).
 *   - Existing attachment count for the task must be < 10 (422 LIMIT_REACHED).
 *
 * Atomicity:
 *   - The count check runs inside a `db.transaction(...)` with `FOR UPDATE`
 *     on the task row, so two concurrent uploads can't both observe count=9
 *     and slip through to count=11.
 *   - The file is written to disk INSIDE the transaction so the row insert
 *     and the on-disk artifact are committed together. If the insert fails
 *     for any reason after the write succeeds, we unlink the file in a
 *     best-effort cleanup before propagating the error.
 *   - The per-task subdirectory is `mkdir -p`'d on every upload (idempotent).
 *
 * Response: 201 with `{ attachment: { id, taskId, filename, mimeType, size,
 *   createdAt } }`. The `storagePath` is intentionally NOT returned — clients
 *   stream attachments through a download endpoint; the on-disk path is an
 *   internal detail.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id || !session.user.tenantId) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to continue");
  }

  const { taskId: rawTaskId } = await context.params;
  const taskIdParse = taskIdParamSchema.safeParse(rawTaskId);
  if (!taskIdParse.success) {
    return errorResponse(400, "INVALID_INPUT", "Invalid task id");
  }
  const taskId = taskIdParse.data;

  // Parse the multipart body. `request.formData()` throws on a non-multipart
  // content type or a malformed body — surface that as a 400 with a stable
  // code instead of a 500.
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorResponse(
      400,
      "INVALID_BODY",
      "Request must be multipart/form-data",
    );
  }

  const filePart = form.get("file");
  if (!filePart || typeof filePart === "string") {
    return errorResponse(
      400,
      "INVALID_BODY",
      "Missing required `file` part in multipart body",
    );
  }
  // From here on `filePart` is the platform `File` (Web API, also a `Blob`).
  const file = filePart as File;

  // Run the shared upload-validator. The lib distinguishes empty / too-large
  // / invalid-type / missing-name; we map each onto the appropriate HTTP
  // surface:
  //   - missing_name / empty -> 422 INVALID_INPUT (client bugs).
  //   - too_large           -> 422 LIMIT_REACHED (per the task spec — strict
  //                            HTTP would prefer 413, but the contract here
  //                            says 422 so the kanban UI can surface size
  //                            and count overflows on the same error code).
  //   - invalid_type        -> 415 UNSUPPORTED_MEDIA_TYPE (HTTP-spec correct
  //                            and matches what the validation lib's docs
  //                            recommend).
  const validation = validateUpload({
    size: file.size,
    type: file.type,
    name: file.name,
  });
  if (!validation.ok) {
    switch (validation.reason) {
      case "missing_name":
        return errorResponse(
          422,
          "INVALID_INPUT",
          "Uploaded file is missing a filename",
        );
      case "empty":
        return errorResponse(
          422,
          "INVALID_INPUT",
          "Uploaded file is empty",
        );
      case "too_large":
        return errorResponse(
          422,
          "LIMIT_REACHED",
          `File exceeds the ${Math.floor(
            validation.maxBytes / (1024 * 1024),
          )} MB limit`,
          { maxBytes: validation.maxBytes, actualBytes: validation.actualBytes },
        );
      case "invalid_type":
        return errorResponse(
          415,
          "UNSUPPORTED_MEDIA_TYPE",
          `Unsupported file type: ${validation.mimeType || "unknown"}`,
          { allowed: validation.allowed },
        );
    }
  }

  try {
    // 1. Locate the task and resolve the owning project. Cross-tenant rows
    //    fall through to step 2 and collapse to 404 in the access helper.
    const [taskRow] = await db
      .select({
        id: tasks.id,
        projectId: columns.projectId,
      })
      .from(tasks)
      .innerJoin(columns, eq(columns.id, tasks.columnId))
      .where(eq(tasks.id, taskId))
      .limit(1);

    if (!taskRow) {
      return errorResponse(404, "NOT_FOUND", "Task not found");
    }

    const access = await resolveProjectAccessByProjectId({
      projectId: taskRow.projectId,
      tenantId: session.user.tenantId,
      userId: session.user.id,
    });

    if (!access.ok) {
      if (access.reason === "forbidden") {
        return errorResponse(
          403,
          "FORBIDDEN",
          "You do not have access to this task",
        );
      }
      return errorResponse(404, "NOT_FOUND", "Task not found");
    }

    // Membership gate. Public projects let non-members read tasks but every
    // write path — including attachment uploads — requires team membership.
    if (!access.isMember) {
      return errorResponse(
        403,
        "FORBIDDEN",
        "Only team members can attach files to tasks",
      );
    }

    // 2. Prep the on-disk target. `getUploadDir()` is the absolute base; the
    //    per-task subdir is created lazily here so first-upload-on-a-task
    //    works without a separate provisioning step. If the eager bootstrap
    //    that runs at module import failed, retry the base ensure here so a
    //    transient FS hiccup at boot doesn't permanently brick uploads.
    if (uploadBootstrapFailed()) {
      await ensureUploadDir();
    }
    const baseDir = getUploadDir();
    const taskDir = path.join(baseDir, taskId);
    await mkdir(taskDir, { recursive: true });

    const safeName = sanitizeFilename(file.name);
    const objectId = randomUUID();
    const onDiskName = `${objectId}-${safeName}`;
    const absolutePath = path.join(taskDir, onDiskName);
    // Stored relative to UPLOAD_DIR so the column survives an env-var move
    // (e.g. dev `./uploads` → prod `/var/data/uploads`). The schema doc on
    // `attachments.storagePath` explicitly permits relative-or-absolute.
    const relativePath = path.posix.join(taskId, onDiskName);

    // Buffer the upload once. `arrayBuffer()` materializes the whole file —
    // safe under our 10 MiB cap (validated above) and dramatically simpler
    // than streaming for a serverless function with finite memory anyway.
    const bytes = Buffer.from(await file.arrayBuffer());

    // Pin the validated mime type / filename (post-sanitization for storage,
    // but the original-as-trimmed for display) so the values flowing into the
    // tx don't drift if `file.*` getters are accessed again.
    const storedMimeType = file.type.toLowerCase().trim();
    const storedFilename = (file.name?.trim() ?? "") || safeName;
    const storedSize = file.size;

    // 3. Atomic count + write + insert. We hold a row lock on the task for
    //    the duration so two concurrent uploads can't both observe count=9
    //    and end up at count=11. The file write happens inside the tx so
    //    "DB row exists ⇒ file exists" is preserved on commit. If anything
    //    after the file write throws, we unlink the file in a best-effort
    //    cleanup before re-throwing so the FS doesn't accumulate orphans.
    let fileWritten = false;
    let inserted: {
      id: string;
      taskId: string;
      filename: string;
      mimeType: string;
      size: number;
      createdAt: Date;
    } | null = null;

    try {
      const result = await db.transaction(async (tx) => {
        // Re-read the task FOR UPDATE so a concurrent DELETE serializes
        // through us (we'd lose the race, see "row gone" below).
        const [locked] = await tx
          .select({ id: tasks.id })
          .from(tasks)
          .where(eq(tasks.id, taskId))
          .for("update");

        if (!locked) {
          return { kind: "task_gone" as const };
        }

        // Count(*) under the row lock. Postgres reads are MVCC-isolated by
        // default, but the lock above is what serializes peer uploads — the
        // count is authoritative for the rest of this tx because no other
        // tx can hold the same lock concurrently.
        const [countRow] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(attachments)
          .where(eq(attachments.taskId, taskId));

        const currentCount = countRow?.count ?? 0;
        if (currentCount >= MAX_ATTACHMENTS_PER_TASK) {
          return {
            kind: "limit_reached" as const,
            currentCount,
          };
        }

        // Write the file. Inside the tx because we want the row insert and
        // the on-disk artifact to commit together; outside the tx, a crash
        // between write and insert would orphan a file. The mkdir above is
        // idempotent so the parent dir is guaranteed.
        await writeFile(absolutePath, bytes);
        fileWritten = true;

        const [created] = await tx
          .insert(attachments)
          .values({
            taskId,
            filename: storedFilename,
            storagePath: relativePath,
            mimeType: storedMimeType,
            size: storedSize,
          })
          .returning({
            id: attachments.id,
            taskId: attachments.taskId,
            filename: attachments.filename,
            mimeType: attachments.mimeType,
            size: attachments.size,
            createdAt: attachments.createdAt,
          });

        if (!created) {
          // Drizzle's returning should always yield a row on a successful
          // insert; if it doesn't, the tx is broken and we want to roll
          // back so the file cleanup below runs.
          throw new Error("Attachment insert returned no row");
        }

        return { kind: "ok" as const, attachment: created };
      });

      if (result.kind === "task_gone") {
        return errorResponse(404, "NOT_FOUND", "Task not found");
      }

      if (result.kind === "limit_reached") {
        return errorResponse(
          422,
          "LIMIT_REACHED",
          `Tasks are limited to ${MAX_ATTACHMENTS_PER_TASK} attachments`,
          { max: MAX_ATTACHMENTS_PER_TASK, current: result.currentCount },
        );
      }

      inserted = result.attachment;
    } catch (txErr) {
      // Tx aborted (or the writeFile / insert threw inside it). If the file
      // got written before the abort, drop it so the FS doesn't accumulate
      // orphans. unlink is best-effort: a stale path is preferable to a 500
      // shadowing the real error, so we swallow ENOENT and friends.
      if (fileWritten) {
        try {
          await unlink(absolutePath);
        } catch (cleanupErr) {
          console.error(
            "[POST /api/tasks/[taskId]/attachments] failed to clean up orphaned upload",
            { absolutePath, cleanupErr },
          );
        }
      }
      throw txErr;
    }

    if (!inserted) {
      // Defensive: the tx returned `ok` but we didn't capture the row.
      // Should never happen — surface as a 500 rather than a misleading 200.
      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "Unable to attach file at this time",
      );
    }

    return NextResponse.json(
      {
        attachment: {
          id: inserted.id,
          taskId: inserted.taskId,
          filename: inserted.filename,
          mimeType: inserted.mimeType,
          size: inserted.size,
          createdAt: inserted.createdAt,
        },
      },
      { status: 201 },
    );
  } catch (err: unknown) {
    console.error("[POST /api/tasks/[taskId]/attachments] unexpected error", err);
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to attach file at this time",
    );
  }
}
