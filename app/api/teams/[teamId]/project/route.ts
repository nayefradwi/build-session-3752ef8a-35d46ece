import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/server/auth";
import { resolveProjectAccessByTeamId } from "@/lib/server/projects/access";

// Forced dynamic: every read pulls the session cookie and queries the DB,
// and the response is tenant- + visibility-scoped, so prerender / route
// caching must not apply.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ProjectErrorCode =
  | "INVALID_INPUT"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INTERNAL_ERROR";

const errorResponse = (
  status: number,
  code: ProjectErrorCode,
  message: string,
  details?: unknown,
): NextResponse =>
  NextResponse.json(
    details === undefined
      ? { error: message, code }
      : { error: message, code, details },
    { status },
  );

// teamId comes from the dynamic segment; reject obvious garbage before we
// hit Postgres so the uuid-cast in the WHERE clause never panics with a 500.
const teamIdParamSchema = z.uuid();

/**
 * GET /api/teams/[teamId]/project
 *
 * Returns the team's project (id, name, visibility, createdAt). The current
 * data model auto-seeds one project per team at team-creation time, so this
 * is the canonical "open the team's board" lookup.
 *
 * Authorization:
 *   - Caller must be authenticated (401 otherwise).
 *   - Team must live in the caller's tenant (404 otherwise — never leak
 *     cross-tenant existence).
 *   - If the project is `private`, caller must be a member of the owning
 *     team (403 otherwise).
 *   - If the project is `public`, any tenant member can read it.
 *
 * Response shape:
 *   { project: { id, teamId, name, visibility, createdAt }, isMember }
 *
 * `isMember` is included so the client can decide whether to render member-
 * only affordances (e.g. "Edit project") without a follow-up roundtrip.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ teamId: string }> },
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id || !session.user.tenantId) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in to continue");
  }

  const { teamId: rawTeamId } = await context.params;
  const teamIdParse = teamIdParamSchema.safeParse(rawTeamId);
  if (!teamIdParse.success) {
    return errorResponse(400, "INVALID_INPUT", "Invalid team id");
  }

  try {
    const access = await resolveProjectAccessByTeamId({
      teamId: teamIdParse.data,
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

    return NextResponse.json(
      { project: access.project, isMember: access.isMember },
      { status: 200 },
    );
  } catch (err: unknown) {
    console.error(
      "[GET /api/teams/[teamId]/project] unexpected error",
      err,
    );
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to load project at this time",
    );
  }
}
