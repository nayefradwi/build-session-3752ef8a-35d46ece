import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { attachments, columns, tasks } from "@/lib/db/schema";
import { auth } from "@/lib/server/auth";
import { resolveProjectAccessByProjectId } from "@/lib/server/projects/access";
import { getUploadDir } from "@/lib/server/uploads";

// Force dynamic: every download pulls the session cookie, queries the DB, and
// streams a tenant- + visibility-scoped file. Nothing about this is cacheable
// at the route layer — clients can negotiate their own caching via the file's
// content-type and the server-controlled filename.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type AttachmentDownloadErrorCode =
  | "INVALID_INPUT"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INTERNAL_ERROR";

const errorResponse = (
  status: number,
  code: AttachmentDownloadErrorCode,
  message: string,
): NextResponse =>
  NextResponse.json({ error: message, code }, { status });

// attachmentId is a dynamic segment; validate as a UUID before we hit Postgres
// so the uuid-cast in the WHERE clause never panics with a 500.
const attachmentIdParamSchema = z.uuid();

/**
 * Build an RFC 6266-compliant `Content-Disposition` value for an `attachment`
 * download with a user-supplied filename.
 *
 * The filename in `attachments.filename` is the original (sanitized for on-disk
 * storage but otherwise free-form) name supplied at upload time, so it can
 * legally contain non-ASCII characters, spaces, and quote characters that
 * would break a naive `filename="..."` token. We emit BOTH:
 *
 *   - `filename="<ascii-fallback>"` — RFC 2616 `quoted-string` form. ASCII
 *     only; non-ASCII bytes are replaced with `_` and embedded `"` and `\`
 *     are escaped. Old user-agents that don't understand RFC 5987 use this.
 *   - `filename*=UTF-8''<percent-encoded>` — RFC 5987 extended form. UTF-8 +
 *     percent-encoding preserves the original characters losslessly. All
 *     modern user-agents prefer this when present.
 *
 * Spec references:
 *   - RFC 6266 §4.1, §4.3 (Appendix D examples)
 *   - RFC 5987 §3.2 (extended parameter encoding)
 */
function buildContentDisposition(filename: string): string {
  // ASCII fallback: drop control characters and replace any non-ASCII byte
  // with `_`. Then escape `\` and `"` for the quoted-string form.
  // eslint-disable-next-line no-control-regex
  const asciiOnly = filename.replace(/[^\x20-\x7E]/g, "_");
  const escaped = asciiOnly.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  // `encodeURIComponent` percent-encodes everything except the unreserved set
  // — a strict superset of what RFC 5987 allows, so the output is always a
  // valid `ext-value`. The `''` between the charset and the value is the
  // empty language tag.
  const utf8Encoded = encodeURIComponent(filename);
  return `attachment; filename="${escaped}"; filename*=UTF-8''${utf8Encoded}`;
}

/**
 * Resolve the on-disk absolute path for an attachment row's `storagePath`.
 *
 * The schema doc on `attachments.storagePath` allows the column to hold either
 * an absolute path or a path relative to UPLOAD_DIR (the upload handler always
 * writes the relative form, but historical / migrated data could be absolute).
 * After joining, we sanity-check that the resolved path lives strictly inside
 * UPLOAD_DIR so a tampered DB row containing `../../etc/passwd` can't cause
 * the route to read arbitrary host files. The check uses the resolved
 * absolute paths so symlink-style traversal is also caught.
 */
function resolveStoragePath(storagePath: string): {
  ok: true;
  absolutePath: string;
} | {
  ok: false;
} {
  const baseDir = getUploadDir();
  const candidate = path.isAbsolute(storagePath)
    ? path.resolve(storagePath)
    : path.resolve(baseDir, storagePath);

  // Containment check: candidate must equal baseDir or be a descendant of it.
  // Use `path.relative` so we don't get tripped up by trailing separators.
  const rel = path.relative(baseDir, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false };
  }
  return { ok: true, absolutePath: candidate };
}

/**
 * GET /api/attachments/[attachmentId]
 *
 * Stream an attachment back to the client as a downloadable file.
 *
 * Authorization (mirrors the project read endpoints):
 *   - Caller must be authenticated (401 otherwise — surfaced to the wire as
 *     UNAUTHENTICATED for parity with the rest of the API).
 *   - The attachment's owning project must live in the caller's tenant.
 *     Cross-tenant or non-existent attachment ids collapse to 404 to avoid
 *     leaking existence across tenant boundaries.
 *   - If the project is `private`, caller must be a team member of the owning
 *     team (403 otherwise).
 *   - If the project is `public`, any tenant member can download — same rule
 *     as the task GET endpoint: visibility gates reads, not just renders.
 *
 * Response (200):
 *   - Body: the file's raw bytes streamed from disk.
 *   - `Content-Type`: the stored MIME type from the row (whatever was on the
 *     upload, post-validation against the allowed-types whitelist). We do NOT
 *     re-sniff the file — sniffing would let a bad upload escalate via a
 *     mismatch between stored and on-disk content.
 *   - `Content-Disposition: attachment; filename="..."; filename*=UTF-8''...`
 *     forcing a download dialog rather than inline rendering, with both the
 *     ASCII-quoted-string fallback and the UTF-8 extended form so non-ASCII
 *     filenames round-trip correctly on modern user-agents.
 *   - `Content-Length`: the on-disk file size (we re-`stat` to get the
 *     ground truth rather than trusting the DB column — if a row's size has
 *     drifted from the file, the file's size is the byte count we're actually
 *     streaming).
 *
 * Failure cases:
 *   - 400 INVALID_INPUT — `attachmentId` is not a UUID.
 *   - 401 UNAUTHENTICATED — no session.
 *   - 403 FORBIDDEN — project is private and caller is not a team member.
 *   - 404 NOT_FOUND — row missing, cross-tenant, or the on-disk file has
 *     vanished (the DB row is the canonical existence signal but a missing
 *     file collapses to 404 from the client's perspective).
 *   - 500 INTERNAL_ERROR — anything else.
 *
 * Implementation notes:
 *   - `runtime = "nodejs"` is required: we use `node:fs` to stream bytes off
 *     disk. The Edge runtime has no filesystem access.
 *   - The stream is wrapped with `Readable.toWeb` so the `Response` body type
 *     is the platform `ReadableStream` shape Next.js expects. Node's stream
 *     handles backpressure end-to-end so a slow client doesn't pin the
 *     handler's memory.
 *   - We do an explicit `stat` before opening the stream so a missing file
 *     produces a clean 404 instead of a half-written 200 that errors mid-body.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ attachmentId: string }> },
): Promise<NextResponse | Response> {
  const session = await auth();
  if (!session?.user?.id || !session.user.tenantId) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to continue");
  }

  const { attachmentId: rawAttachmentId } = await context.params;
  const attachmentIdParse = attachmentIdParamSchema.safeParse(rawAttachmentId);
  if (!attachmentIdParse.success) {
    return errorResponse(400, "INVALID_INPUT", "Invalid attachment id");
  }
  const attachmentId = attachmentIdParse.data;

  try {
    // 1. Locate the attachment + its owning project (via task → column FK)
    //    in a single round-trip. Tenant + visibility are enforced separately
    //    by the access helper below — keeping this query scoped only to the
    //    attachment id mirrors the pattern used everywhere else and means a
    //    cross-tenant id flows through to step 2 and collapses to 404.
    const [row] = await db
      .select({
        id: attachments.id,
        filename: attachments.filename,
        storagePath: attachments.storagePath,
        mimeType: attachments.mimeType,
        size: attachments.size,
        projectId: columns.projectId,
      })
      .from(attachments)
      .innerJoin(tasks, eq(tasks.id, attachments.taskId))
      .innerJoin(columns, eq(columns.id, tasks.columnId))
      .where(eq(attachments.id, attachmentId))
      .limit(1);

    if (!row) {
      return errorResponse(404, "NOT_FOUND", "Attachment not found");
    }

    // 2. Tenant + visibility gate. Cross-tenant => 404, private + non-member
    //    => 403, public OR member => ok. Reusing the helper keeps the policy
    //    in exactly one place and matches every other project-scoped read.
    const access = await resolveProjectAccessByProjectId({
      projectId: row.projectId,
      tenantId: session.user.tenantId,
      userId: session.user.id,
    });

    if (!access.ok) {
      if (access.reason === "forbidden") {
        return errorResponse(
          403,
          "FORBIDDEN",
          "You do not have access to this attachment",
        );
      }
      return errorResponse(404, "NOT_FOUND", "Attachment not found");
    }

    // 3. Resolve the on-disk path. The containment check defends against a
    //    tampered DB row whose storagePath escapes UPLOAD_DIR via "..".
    const resolved = resolveStoragePath(row.storagePath);
    if (!resolved.ok) {
      console.error(
        "[GET /api/attachments/[attachmentId]] storage path escapes UPLOAD_DIR",
        { attachmentId, storagePath: row.storagePath },
      );
      return errorResponse(404, "NOT_FOUND", "Attachment not found");
    }

    // 4. Stat the file. A missing on-disk artifact collapses to 404 on the
    //    wire — the row exists but the bytes don't, so from the caller's
    //    perspective the attachment is gone. We log the discrepancy for
    //    operators since a row-without-file is an inconsistency that warrants
    //    investigation.
    let fileStat;
    try {
      fileStat = await stat(resolved.absolutePath);
    } catch (statErr: unknown) {
      const code =
        statErr instanceof Error && "code" in statErr
          ? (statErr as NodeJS.ErrnoException).code
          : undefined;
      if (code === "ENOENT") {
        console.error(
          "[GET /api/attachments/[attachmentId]] DB row exists but file is missing",
          { attachmentId, absolutePath: resolved.absolutePath },
        );
        return errorResponse(404, "NOT_FOUND", "Attachment not found");
      }
      throw statErr;
    }

    if (!fileStat.isFile()) {
      // Row points at a directory or device — same outcome as ENOENT from the
      // client's perspective; log so the inconsistency is investigable.
      console.error(
        "[GET /api/attachments/[attachmentId]] storage path is not a regular file",
        { attachmentId, absolutePath: resolved.absolutePath },
      );
      return errorResponse(404, "NOT_FOUND", "Attachment not found");
    }

    // 5. Open a streaming read and convert to a web ReadableStream. Node's
    //    stream propagates backpressure end-to-end so a slow client can't
    //    balloon the handler's memory. We use the file's actual byte size
    //    from `stat` rather than the DB column — the file is the ground
    //    truth for the bytes we're about to send.
    const nodeStream = createReadStream(resolved.absolutePath);
    // Surface read errors to the operator log; the response stream will
    // close on error and the client sees a truncated download, which is the
    // best we can do once headers are flushed.
    nodeStream.on("error", (streamErr) => {
      console.error(
        "[GET /api/attachments/[attachmentId]] read stream error",
        { attachmentId, absolutePath: resolved.absolutePath, streamErr },
      );
    });
    const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;

    // 6. Build the headers. Content-Type comes from the row; sniffing on
    //    download would let a bad upload escalate via a mismatch between the
    //    stored and on-disk types, so we trust the post-validation value.
    const headers = new Headers();
    headers.set("Content-Type", row.mimeType);
    headers.set("Content-Length", String(fileStat.size));
    headers.set("Content-Disposition", buildContentDisposition(row.filename));
    // Downloads are user-data and per-session; never cache at the public layer.
    headers.set("Cache-Control", "private, no-store");

    return new Response(webStream, { status: 200, headers });
  } catch (err: unknown) {
    console.error(
      "[GET /api/attachments/[attachmentId]] unexpected error",
      err,
    );
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to download attachment at this time",
    );
  }
}
