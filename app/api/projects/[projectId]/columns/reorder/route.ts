import { and, asc, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { columns, projects, teamMemberships } from "@/lib/db/schema";
import { auth } from "@/lib/server/auth";
import { recalculatePositions } from "@/lib/server/position";
import { resolveProjectAccessByProjectId } from "@/lib/server/projects/access";

// Forced dynamic: every call mutates state, is gated by the session cookie,
// and is tenant-scoped at the DB layer. Prerender / route caching must not
// apply.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ReorderErrorCode =
  | "INVALID_JSON"
  | "INVALID_INPUT"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INTERNAL_ERROR";

const errorResponse = (
  status: number,
  code: ReorderErrorCode,
  message: string,
  details?: unknown,
): NextResponse =>
  NextResponse.json(
    details === undefined
      ? { error: message, code }
      : { error: message, code, details },
    { status },
  );

// projectId is a dynamic segment; validate as a UUID before we hit Postgres
// so the uuid-cast in the WHERE clause never panics with a 500 on garbage.
const projectIdParamSchema = z.uuid();

/**
 * Body shape for the reorder PATCH.
 *
 *   - `orderedColumnIds` is the FULL ordered list of the project's column ids.
 *     Position assignment is implicit: index in the array becomes the new
 *     `position` value. This contract is deliberate — partial reorder payloads
 *     leave too much room for the client and server to disagree about the
 *     resulting lane order, so we require the full set every call. The handler
 *     enforces the same: it rejects payloads where the id set doesn't exactly
 *     match the project's current column ids.
 *
 *   - Empty array is rejected. A project with zero columns has nothing to
 *     reorder; allowing it would just be a no-op and complicates the "exactly
 *     matches" invariant. Use POST/DELETE to manage column existence.
 *
 *   - Duplicates are rejected at the schema layer rather than via a manual
 *     `Set.size === array.length` check after `safeParse` — keeps the rejection
 *     reason inside the standard Zod error tree so the client gets the same
 *     `details` shape it already handles.
 */
const reorderInputSchema = z
  .object({
    orderedColumnIds: z
      .array(z.uuid())
      .min(1, "orderedColumnIds must not be empty")
      // Cap matches MAX_COLUMNS_PER_PROJECT in the sibling POST handler — a
      // payload longer than the cap can't possibly be a valid full ordering of
      // the project's columns, so we reject it before hitting the DB.
      .max(10, "orderedColumnIds exceeds the maximum number of columns")
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "orderedColumnIds must not contain duplicates",
      ),
  })
  // .strict() so unknown keys fail validation rather than silently dropping —
  // protects against client typos like { columnIds: [...] } turning into a
  // schema-shaped no-op the server then complains about as "empty".
  .strict();

/**
 * PATCH /api/projects/[projectId]/columns/reorder
 *
 * Reorder a project's kanban columns by submitting the FULL ordered list of
 * column ids. The server treats the array index as the new `position` value
 * for each column, re-stamping all rows in a single transaction.
 *
 * Body: `{ orderedColumnIds: string[] }`.
 *
 * Authorization:
 *   - Caller must be authenticated (401 otherwise).
 *   - Project's owning team must live in the caller's tenant (404 otherwise
 *     — never leak cross-tenant existence).
 *   - Caller must be a *team admin* (`team_memberships.role = "admin"`) of
 *     the owning team. Tenant-level admins do NOT bypass; column management
 *     is a team-scoped operation, mirroring POST / PUT on the column routes.
 *     Non-admin members and non-members of a private project both get 403.
 *
 * Validation:
 *   - All ids must be valid UUIDs (schema-level).
 *   - The submitted set must exactly match the project's current column ids
 *     (no missing, no extra). Anything else is 422 — letting partial payloads
 *     through would leave the project in a state where the array index ↔
 *     position invariant doesn't hold across rows, which is exactly the bug
 *     this contract is meant to prevent.
 *
 * Concurrency strategy:
 *   - We acquire `SELECT ... FOR UPDATE` on the project row so concurrent
 *     reorders / creates / renames serialize against each other, mirroring
 *     POST /api/projects/[projectId]/columns. Inside the lock we re-read the
 *     project's columns and validate the submitted set, then re-stamp.
 *
 *   - The unique index `(projectId, position)` is non-deferrable, so a naive
 *     "UPDATE each row to its new position" pass would hit 23505 the moment
 *     we tried to swap two rows. We work around it with a two-phase write:
 *       1. Shift every column in the project into a disjoint negative range
 *          (`position = -(position + 1)`). Original positions are unique by
 *          the index, so the negated set is also unique — no collisions.
 *       2. Re-stamp each column to its target index in the orderedColumnIds
 *          array. The negative-positioned rows can't collide with the
 *          new 0..N-1 range, so each UPDATE lands cleanly.
 *     Both phases run inside the same transaction; on rollback the original
 *     positions come back intact.
 *
 * Response: 200 with `{ columns: Array<{ id, projectId, name, position }> }`
 * — same shape as `GET /api/projects/[projectId]/columns`, ordered by the
 * new positions ascending. Returning the full list lets the client adopt the
 * canonical state without a follow-up GET.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id || !session.user.tenantId) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to continue");
  }

  const { projectId: rawProjectId } = await context.params;
  const projectIdParse = projectIdParamSchema.safeParse(rawProjectId);
  if (!projectIdParse.success) {
    return errorResponse(400, "INVALID_INPUT", "Invalid project id");
  }
  const projectId = projectIdParse.data;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(
      400,
      "INVALID_JSON",
      "Request body must be valid JSON",
    );
  }

  const parsed = reorderInputSchema.safeParse(rawBody);
  if (!parsed.success) {
    return errorResponse(
      400,
      "INVALID_INPUT",
      "Validation failed",
      z.treeifyError(parsed.error),
    );
  }
  const { orderedColumnIds } = parsed.data;

  try {
    // 1. Tenant + visibility gate via the shared helper. Cross-tenant or
    //    missing projects collapse to 404; private + non-member is 403.
    //    The team-admin gate below is strictly stronger but resolving access
    //    first lets us return the canonical 404 for missing / cross-tenant
    //    projects without leaking via the admin probe.
    const access = await resolveProjectAccessByProjectId({
      projectId,
      tenantId: session.user.tenantId,
      userId: session.user.id,
    });

    if (!access.ok) {
      if (access.reason === "forbidden") {
        return errorResponse(
          403,
          "FORBIDDEN",
          "You do not have access to this project",
        );
      }
      return errorResponse(404, "NOT_FOUND", "Project not found");
    }

    // 2. Team-admin gate. Tenant admins do NOT bypass: column management is a
    //    team-scoped operation, mirroring POST / PUT on the column routes.
    const [callerMembership] = await db
      .select({ role: teamMemberships.role })
      .from(teamMemberships)
      .where(
        and(
          eq(teamMemberships.teamId, access.team.id),
          eq(teamMemberships.userId, session.user.id),
        ),
      )
      .limit(1);

    if (!callerMembership || callerMembership.role !== "admin") {
      return errorResponse(
        403,
        "FORBIDDEN",
        "Only team admins can reorder columns",
      );
    }

    // 3. Transactional reorder under the project row lock.
    const result = await db.transaction(async (tx) => {
      // 3a. Lock the project row. Concurrent column creates / renames /
      //     reorders all coordinate via this same lock, so the column set we
      //     read next is authoritative for the duration of this tx.
      await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, access.project.id))
        .for("update");

      // 3b. Read the project's current columns under the lock. This is the
      //     ground truth we validate the submitted ordering against.
      const existing = await tx
        .select({ id: columns.id })
        .from(columns)
        .where(eq(columns.projectId, access.project.id));

      // The submitted id set must EXACTLY match the project's current column
      // id set — no missing, no extra. Length parity is a fast pre-check;
      // the membership check below catches mismatched contents at equal size
      // (e.g., a foreign id swapped in for a project id).
      if (existing.length !== orderedColumnIds.length) {
        return { kind: "set_mismatch" as const };
      }
      const existingIds = new Set(existing.map((row) => row.id));
      for (const id of orderedColumnIds) {
        if (!existingIds.has(id)) {
          return { kind: "set_mismatch" as const };
        }
      }

      // 3c. Two-phase re-stamp. The (projectId, position) unique index is
      //     non-deferrable, so we can't directly swap two rows' positions in
      //     a naive UPDATE-per-row pass — the first UPDATE would collide
      //     with whichever row currently holds the target position.
      //
      //     Phase 1: shift every column in the project into a disjoint
      //     negative range. `position = -(position + 1)` is bijective over
      //     the existing unique positions, so the negated set is also unique
      //     — no 23505 — and lands entirely below 0, leaving the [0, N-1]
      //     range free for phase 2.
      await tx
        .update(columns)
        .set({ position: sql`-(${columns.position} + 1)` })
        .where(eq(columns.projectId, access.project.id));

      // Phase 2: stamp each column at its target slot. Positions follow
      // the canonical POSITION_STEP (1000) spacing produced by the
      // shared `recalculatePositions` helper — `index * 1000` rather
      // than the bare index — so subsequent mid-inserts (a column drag
      // landing between two siblings) have headroom without forcing
      // another re-stamp. We re-assert the column→project relationship
      // in the WHERE clause as defense-in-depth: the set-equality check
      // above already guarantees the id is in this project, but the
      // extra predicate prevents a stale id from a concurrent
      // (now-failed) cascade-delete from accidentally landing.
      const stamped = recalculatePositions(
        orderedColumnIds.map((id) => ({ id, position: 0 })),
      );
      for (const row of stamped) {
        await tx
          .update(columns)
          .set({ position: row.position })
          .where(
            and(
              eq(columns.id, row.id),
              eq(columns.projectId, access.project.id),
            ),
          );
      }

      // 3d. Re-read the post-reorder column list inside the same tx so the
      //     response reflects exactly what we just wrote, not whatever a
      //     follow-up read might pick up after the lock releases.
      const rows = await tx
        .select({
          id: columns.id,
          projectId: columns.projectId,
          name: columns.name,
          position: columns.position,
        })
        .from(columns)
        .where(eq(columns.projectId, access.project.id))
        .orderBy(asc(columns.position));

      return { kind: "ok" as const, columns: rows };
    });

    if (result.kind === "set_mismatch") {
      return errorResponse(
        422,
        "INVALID_INPUT",
        "orderedColumnIds must contain exactly the project's current column ids",
      );
    }

    return NextResponse.json({ columns: result.columns }, { status: 200 });
  } catch (err: unknown) {
    console.error(
      "[PATCH /api/projects/[projectId]/columns/reorder] unexpected error",
      err,
    );
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to reorder columns at this time",
    );
  }
}
