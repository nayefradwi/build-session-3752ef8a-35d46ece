import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { projects, teamMemberships } from "@/lib/db/schema";
import { auth } from "@/lib/server/auth";
import { resolveProjectAccessByTeamId } from "@/lib/server/projects/access";

// Forced dynamic: every read pulls the session cookie and queries the DB,
// and the response is tenant- + visibility-scoped, so prerender / route
// caching must not apply.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ProjectErrorCode =
  | "INVALID_JSON"
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

// Body shape for PUT. Both fields are accepted but `name` is optional — the
// common edit flow flips visibility without renaming. We trim+bound `name`
// for the same reasons POST /api/teams does (no whitespace-only labels, keep
// arbitrary-length strings out of the DB), and constrain visibility to the
// two enum values that exist on `projects.visibility`.
const updateProjectInputSchema = z
  .object({
    visibility: z.enum(["public", "private"]),
    name: z.string().trim().min(1).max(120).optional(),
  })
  // .strict() so unknown keys fail validation rather than silently dropping —
  // protects against client typos like { visiblity: "public" } turning into
  // a no-op on the wrong field.
  .strict();

/**
 * PUT /api/teams/[teamId]/project
 *
 * Update the team's project. Body: `{ visibility: "public" | "private",
 * name?: string }`.
 *
 * Authorization:
 *   - Caller must be authenticated (401 otherwise).
 *   - Project's owning team must live in the caller's tenant (404 otherwise
 *     — never leak cross-tenant existence).
 *   - Caller must be a *team admin* (`team_memberships.role = "admin"`) of
 *     the owning team. Tenant-level admins do NOT bypass; project settings
 *     are a team-scoped operation, mirroring the columns / members endpoints.
 *     Non-admin members get 403, as do non-members of a private project
 *     (which fall out of the visibility gate as 403 first).
 *
 * Race safety: the row is locked with `FOR UPDATE` inside a transaction
 * before the UPDATE so two concurrent admins editing the same project
 * serialize through the lock and the response always reflects the final
 * post-write state.
 *
 * Response: 200 with `{ project: { id, teamId, name, visibility, createdAt } }`.
 */
export async function PUT(
  request: Request,
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

  const parsed = updateProjectInputSchema.safeParse(rawBody);
  if (!parsed.success) {
    return errorResponse(
      400,
      "INVALID_INPUT",
      "Validation failed",
      z.treeifyError(parsed.error),
    );
  }
  const { visibility, name } = parsed.data;

  try {
    // 1. Resolve project access. This enforces tenant isolation (cross-tenant
    //    team => 404) and the visibility gate (private + non-member => 403).
    //    The team-admin gate below is strictly stronger than the visibility
    //    check, but resolving access first lets us return the canonical 404
    //    for missing/cross-tenant teams without leaking via the admin probe.
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

    // 2. Team-admin gate. Tenant admins do NOT bypass: project settings are a
    //    team-scoped operation, mirroring the columns / members endpoints.
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
        "Only team admins can update the project",
      );
    }

    // 3. Lock + update the project row in a single transaction. Two concurrent
    //    admins editing the same project will serialize through the FOR UPDATE
    //    lock, so the row we re-read in `.returning()` is guaranteed to be the
    //    post-write state of *this* transaction.
    const updated = await db.transaction(async (tx) => {
      await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, access.project.id))
        .for("update");

      // Build the patch dynamically so undefined `name` doesn't get coerced
      // into a NULL UPDATE — Drizzle's `set` would otherwise emit `name = $n`
      // with a JS-undefined that ends up as a SQL NULL in some drivers.
      const patch: { visibility: "public" | "private"; name?: string } = {
        visibility,
      };
      if (name !== undefined) {
        patch.name = name;
      }

      const [row] = await tx
        .update(projects)
        .set(patch)
        .where(eq(projects.id, access.project.id))
        .returning({
          id: projects.id,
          teamId: projects.teamId,
          name: projects.name,
          visibility: projects.visibility,
          createdAt: projects.createdAt,
        });

      return row;
    });

    return NextResponse.json({ project: updated }, { status: 200 });
  } catch (err: unknown) {
    console.error(
      "[PUT /api/teams/[teamId]/project] unexpected error",
      err,
    );
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to update project at this time",
    );
  }
}
