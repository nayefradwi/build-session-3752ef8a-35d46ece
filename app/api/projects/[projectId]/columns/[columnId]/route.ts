import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { columns, teamMemberships } from "@/lib/db/schema";
import { auth } from "@/lib/server/auth";
import { resolveProjectAccessByProjectId } from "@/lib/server/projects/access";

// Forced dynamic: every write pulls the session cookie + queries the DB, and
// the response is tenant- + visibility-scoped, so prerender / route caching
// must not apply.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ColumnErrorCode =
  | "INVALID_JSON"
  | "INVALID_INPUT"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INTERNAL_ERROR";

const errorResponse = (
  status: number,
  code: ColumnErrorCode,
  message: string,
  details?: unknown,
): NextResponse =>
  NextResponse.json(
    details === undefined
      ? { error: message, code }
      : { error: message, code, details },
    { status },
  );

// projectId / columnId come from the dynamic segments; validate as UUIDs
// before we hit Postgres so the uuid-cast in the WHERE clause never panics
// with a 500 on obvious garbage.
const projectIdParamSchema = z.uuid();
const columnIdParamSchema = z.uuid();

// Body shape for PUT. `name` is currently the only mutable field on a column
// — `position` is reordered through dedicated move endpoints, and `projectId`
// is structural (cross-project moves aren't a feature). We trim+bound the
// same way POST /api/projects/[projectId]/columns does so we don't admit
// whitespace-only labels or arbitrary-length strings into the DB.
const updateColumnInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
  })
  // .strict() so unknown keys fail validation rather than silently dropping —
  // protects against client typos like { tname: "..." } turning into a no-op.
  .strict();

/**
 * PUT /api/projects/[projectId]/columns/[columnId]
 *
 * Update a column's metadata. Body: `{ name: string }`.
 *
 * Authorization:
 *   - Caller must be authenticated (401 otherwise).
 *   - Project's owning team must live in the caller's tenant (404 otherwise
 *     — never leak cross-tenant existence).
 *   - Column must belong to the project named in the URL (404 otherwise; a
 *     mismatched [projectId, columnId] pair is indistinguishable from "the
 *     column doesn't exist" from the caller's perspective).
 *   - Caller must be a *team admin* (`team_memberships.role = "admin"`) of
 *     the owning team. Tenant-level admins do NOT bypass; column management
 *     is a team-scoped operation, mirroring the sibling POST handler and the
 *     team / project endpoints. Non-admin members of the team get 403, as do
 *     non-members of a private project (which fall out of the visibility
 *     gate as 403 first).
 *
 * Race safety: the column row is locked with `FOR UPDATE` inside a
 * transaction before the UPDATE so two concurrent admins renaming the same
 * column serialize through the lock and the response always reflects the
 * final post-write state of *this* transaction. We re-assert the
 * column→project relationship in the UPDATE WHERE clause as defense-in-depth:
 * if the column were somehow moved between the existence check and the
 * UPDATE, the row count would be zero and the transaction would correctly
 * surface a 404.
 *
 * Response: 200 with `{ column: { id, projectId, name, position } }`.
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ projectId: string; columnId: string }> },
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id || !session.user.tenantId) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to continue");
  }

  const { projectId: rawProjectId, columnId: rawColumnId } =
    await context.params;
  const projectIdParse = projectIdParamSchema.safeParse(rawProjectId);
  if (!projectIdParse.success) {
    return errorResponse(400, "INVALID_INPUT", "Invalid project id");
  }
  const columnIdParse = columnIdParamSchema.safeParse(rawColumnId);
  if (!columnIdParse.success) {
    return errorResponse(400, "INVALID_INPUT", "Invalid column id");
  }
  const projectId = projectIdParse.data;
  const columnId = columnIdParse.data;

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

  const parsed = updateColumnInputSchema.safeParse(rawBody);
  if (!parsed.success) {
    return errorResponse(
      400,
      "INVALID_INPUT",
      "Validation failed",
      z.treeifyError(parsed.error),
    );
  }
  const { name } = parsed.data;

  try {
    // 1. Resolve project access. This enforces tenant isolation (cross-tenant
    //    project => 404) and the visibility gate (private + non-member =>
    //    403). The team-admin gate below is strictly stronger, but resolving
    //    access first lets us return the canonical 404 for missing /
    //    cross-tenant projects without leaking via the admin probe.
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
    //    team-scoped operation, mirroring the sibling POST handler and the
    //    team / project endpoints. Non-admin members and non-members of a
    //    public project both get 403 here.
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
        "Only team admins can update columns",
      );
    }

    // 3. Verify the column belongs to this project. Done outside the
    //    transaction since a missing column short-circuits before we take
    //    any locks. The (id, projectId) compound filter is what makes a
    //    mismatched [projectId, columnId] pair indistinguishable from "the
    //    column doesn't exist" — the response is the same 404 either way.
    const [existing] = await db
      .select({ id: columns.id })
      .from(columns)
      .where(
        and(eq(columns.id, columnId), eq(columns.projectId, access.project.id)),
      )
      .limit(1);

    if (!existing) {
      return errorResponse(404, "NOT_FOUND", "Column not found");
    }

    // 4. Lock + update the column row in a single transaction. Two concurrent
    //    admins renaming the same column serialize through the FOR UPDATE
    //    lock, so the row we re-read in `.returning()` reflects the post-
    //    write state of *this* transaction. We re-assert the column->project
    //    relationship in the UPDATE WHERE clause as defense-in-depth: if the
    //    column were somehow moved between the existence check and the
    //    UPDATE, the row count would be zero and the transaction would
    //    correctly surface a 404.
    const updated = await db.transaction(async (tx) => {
      await tx
        .select({ id: columns.id })
        .from(columns)
        .where(
          and(
            eq(columns.id, columnId),
            eq(columns.projectId, access.project.id),
          ),
        )
        .for("update");

      const [row] = await tx
        .update(columns)
        .set({ name })
        .where(
          and(
            eq(columns.id, columnId),
            eq(columns.projectId, access.project.id),
          ),
        )
        .returning({
          id: columns.id,
          projectId: columns.projectId,
          name: columns.name,
          position: columns.position,
        });

      return row;
    });

    if (!updated) {
      // Defensive: the existence check above passed but the UPDATE found no
      // row — only possible if the column was deleted between the two queries.
      return errorResponse(404, "NOT_FOUND", "Column not found");
    }

    return NextResponse.json({ column: updated }, { status: 200 });
  } catch (err: unknown) {
    console.error(
      "[PUT /api/projects/[projectId]/columns/[columnId]] unexpected error",
      err,
    );
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to update column at this time",
    );
  }
}
