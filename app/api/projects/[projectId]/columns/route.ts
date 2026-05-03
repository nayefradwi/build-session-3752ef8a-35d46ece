import { asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { columns } from "@/lib/db/schema";
import { auth } from "@/lib/server/auth";
import { resolveProjectAccessByProjectId } from "@/lib/server/projects/access";

// Forced dynamic: every read pulls the session cookie and queries the DB,
// and the response is tenant- + visibility-scoped, so prerender / route
// caching must not apply.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ColumnsErrorCode =
  | "INVALID_INPUT"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INTERNAL_ERROR";

const errorResponse = (
  status: number,
  code: ColumnsErrorCode,
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
// so the uuid-cast in the WHERE clause never panics with a 500.
const projectIdParamSchema = z.uuid();

/**
 * GET /api/projects/[projectId]/columns
 *
 * Returns the project's kanban-style columns ordered by `position` ascending
 * — the canonical render order for the board.
 *
 * Authorization:
 *   - Caller must be authenticated (401 otherwise).
 *   - Project's owning team must live in the caller's tenant (404 otherwise
 *     — never leak cross-tenant existence).
 *   - If the project is `private`, caller must be a team member of the
 *     owning team (403 otherwise).
 *   - If the project is `public`, any tenant member can read it.
 *
 * Response shape: `{ columns: Array<{ id, projectId, name, position }> }`.
 */
export async function GET(
  _request: Request,
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

  try {
    const access = await resolveProjectAccessByProjectId({
      projectId: projectIdParse.data,
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

    // The (projectId, position) unique index in lib/db/schema.ts means this
    // ORDER BY can be served straight from the index — no sort step needed
    // at the planner level.
    const rows = await db
      .select({
        id: columns.id,
        projectId: columns.projectId,
        name: columns.name,
        position: columns.position,
      })
      .from(columns)
      .where(eq(columns.projectId, access.project.id))
      .orderBy(asc(columns.position));

    return NextResponse.json({ columns: rows }, { status: 200 });
  } catch (err: unknown) {
    console.error(
      "[GET /api/projects/[projectId]/columns] unexpected error",
      err,
    );
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to load columns at this time",
    );
  }
}
