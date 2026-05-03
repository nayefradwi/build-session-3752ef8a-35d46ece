import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { teamMemberships, teams } from "@/lib/db/schema";
import { auth } from "@/lib/server/auth";

// Forced dynamic: every handler authenticates and writes; never cache.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type MemberErrorCode =
  | "INVALID_JSON"
  | "INVALID_INPUT"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "LAST_ADMIN"
  | "INTERNAL_ERROR";

const errorResponse = (
  status: number,
  code: MemberErrorCode,
  message: string,
  details?: unknown,
): NextResponse =>
  NextResponse.json(
    details === undefined
      ? { error: message, code }
      : { error: message, code, details },
    { status },
  );

const paramsSchema = z.object({
  teamId: z.uuid(),
  userId: z.uuid(),
});

const updateRoleInputSchema = z.object({
  role: z.enum(["admin", "member"]),
});

/**
 * Resolve the dynamic segment params and the session, plus enforce the two
 * cross-cutting checks every handler in this file needs:
 *
 *   - team exists in the caller's tenant (else 404),
 *   - caller is a team-admin of that team (else 403).
 *
 * Returns either an error `NextResponse` or the resolved context object. The
 * call site early-returns the response if `error` is set.
 */
async function resolveAdminContext(
  context: { params: Promise<{ teamId: string; userId: string }> },
): Promise<
  | { error: NextResponse }
  | {
      teamId: string;
      targetUserId: string;
      callerId: string;
      tenantId: string;
    }
> {
  const session = await auth();
  if (!session?.user?.id || !session.user.tenantId) {
    return { error: errorResponse(401, "UNAUTHENTICATED", "Sign in to continue") };
  }

  const rawParams = await context.params;
  const parsedParams = paramsSchema.safeParse(rawParams);
  if (!parsedParams.success) {
    return {
      error: errorResponse(400, "INVALID_INPUT", "Invalid team or user id"),
    };
  }
  const { teamId, userId: targetUserId } = parsedParams.data;
  const tenantId = session.user.tenantId;
  const callerId = session.user.id;

  // Tenant-scoped team lookup. A team in another tenant collapses to 404 so
  // we don't leak existence across tenants.
  const [team] = await db
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.tenantId, tenantId)))
    .limit(1);

  if (!team) {
    return { error: errorResponse(404, "NOT_FOUND", "Team not found") };
  }

  // Caller must be a team-admin. Tenant-admins do NOT bypass the team-admin
  // role check — they have to be members of the team to manage it.
  const [callerMembership] = await db
    .select({ role: teamMemberships.role })
    .from(teamMemberships)
    .where(
      and(
        eq(teamMemberships.teamId, teamId),
        eq(teamMemberships.userId, callerId),
      ),
    )
    .limit(1);

  if (!callerMembership || callerMembership.role !== "admin") {
    return {
      error: errorResponse(
        403,
        "FORBIDDEN",
        "Only team admins can manage members",
      ),
    };
  }

  return { teamId, targetUserId, callerId, tenantId };
}

/**
 * PUT /api/teams/[teamId]/members/[userId]
 *
 * Change the team-role of an existing member. Body: `{ role: "admin" |
 * "member" }`.
 *
 * Last-admin invariant: a team must always have at least one admin. Demoting
 * the only remaining admin (admin -> member) is rejected with 409 LAST_ADMIN.
 * Promoting a member to admin or no-op writes (admin -> admin, member ->
 * member) are always allowed.
 *
 * Race safety: the count + write happen inside a single transaction with
 * `FOR UPDATE` row locks on every admin row for the team. Two concurrent
 * demotions of distinct admins serialize through that lock, so we never end
 * up in a "both passed the check" state where the team loses every admin.
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ teamId: string; userId: string }> },
): Promise<NextResponse> {
  const ctx = await resolveAdminContext(context);
  if ("error" in ctx) return ctx.error;
  const { teamId, targetUserId } = ctx;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(400, "INVALID_JSON", "Request body must be valid JSON");
  }

  const parsed = updateRoleInputSchema.safeParse(rawBody);
  if (!parsed.success) {
    return errorResponse(
      400,
      "INVALID_INPUT",
      "Validation failed",
      z.treeifyError(parsed.error),
    );
  }
  const { role: newRole } = parsed.data;

  try {
    const result = await db.transaction(async (tx) => {
      // Lock every admin membership row for this team. Postgres holds the
      // locks until COMMIT/ROLLBACK; concurrent transactions doing the same
      // SELECT block until we finish, so the count we read is authoritative
      // for the duration of this transaction.
      const lockedAdmins = await tx
        .select({ userId: teamMemberships.userId })
        .from(teamMemberships)
        .where(
          and(
            eq(teamMemberships.teamId, teamId),
            eq(teamMemberships.role, "admin"),
          ),
        )
        .for("update");

      // Find the target's current role under the lock (re-reading inside the
      // tx to avoid TOCTOU on the membership state).
      const [target] = await tx
        .select({ role: teamMemberships.role })
        .from(teamMemberships)
        .where(
          and(
            eq(teamMemberships.teamId, teamId),
            eq(teamMemberships.userId, targetUserId),
          ),
        )
        .limit(1);

      if (!target) {
        return { kind: "not_found" as const };
      }

      // Demoting the last admin is the invariant violation. Check matters
      // only for admin -> member transitions; everything else is fine.
      if (target.role === "admin" && newRole === "member") {
        if (lockedAdmins.length <= 1) {
          return { kind: "last_admin" as const };
        }
      }

      // No-op write returns the existing row so the API contract stays the
      // same (and so the client can refresh its local state from the
      // response without special-casing).
      if (target.role === newRole) {
        const [unchanged] = await tx
          .select({
            userId: teamMemberships.userId,
            teamId: teamMemberships.teamId,
            role: teamMemberships.role,
            createdAt: teamMemberships.createdAt,
          })
          .from(teamMemberships)
          .where(
            and(
              eq(teamMemberships.teamId, teamId),
              eq(teamMemberships.userId, targetUserId),
            ),
          )
          .limit(1);
        return { kind: "ok" as const, membership: unchanged! };
      }

      const [updated] = await tx
        .update(teamMemberships)
        .set({ role: newRole })
        .where(
          and(
            eq(teamMemberships.teamId, teamId),
            eq(teamMemberships.userId, targetUserId),
          ),
        )
        .returning({
          userId: teamMemberships.userId,
          teamId: teamMemberships.teamId,
          role: teamMemberships.role,
          createdAt: teamMemberships.createdAt,
        });

      return { kind: "ok" as const, membership: updated };
    });

    if (result.kind === "not_found") {
      return errorResponse(404, "NOT_FOUND", "Membership not found");
    }
    if (result.kind === "last_admin") {
      return errorResponse(
        409,
        "LAST_ADMIN",
        "Cannot demote the last admin of the team",
      );
    }
    return NextResponse.json({ membership: result.membership }, { status: 200 });
  } catch (err: unknown) {
    console.error(
      "[PUT /api/teams/[teamId]/members/[userId]] unexpected error",
      err,
    );
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to update member at this time",
    );
  }
}

/**
 * DELETE /api/teams/[teamId]/members/[userId]
 *
 * Remove a member from the team. Same last-admin invariant as PUT: removing
 * the only remaining admin is rejected with 409 LAST_ADMIN. The check + the
 * delete run in a single transaction with `FOR UPDATE` locks on the team's
 * admin rows so concurrent removals serialize.
 */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ teamId: string; userId: string }> },
): Promise<NextResponse> {
  const ctx = await resolveAdminContext(context);
  if ("error" in ctx) return ctx.error;
  const { teamId, targetUserId } = ctx;

  try {
    const result = await db.transaction(async (tx) => {
      const lockedAdmins = await tx
        .select({ userId: teamMemberships.userId })
        .from(teamMemberships)
        .where(
          and(
            eq(teamMemberships.teamId, teamId),
            eq(teamMemberships.role, "admin"),
          ),
        )
        .for("update");

      const [target] = await tx
        .select({ role: teamMemberships.role })
        .from(teamMemberships)
        .where(
          and(
            eq(teamMemberships.teamId, teamId),
            eq(teamMemberships.userId, targetUserId),
          ),
        )
        .limit(1);

      if (!target) {
        return { kind: "not_found" as const };
      }

      // Removing an admin when they're the only admin would empty the admin
      // set. Refuse rather than orphan the team.
      if (target.role === "admin" && lockedAdmins.length <= 1) {
        return { kind: "last_admin" as const };
      }

      await tx
        .delete(teamMemberships)
        .where(
          and(
            eq(teamMemberships.teamId, teamId),
            eq(teamMemberships.userId, targetUserId),
          ),
        );

      return { kind: "ok" as const };
    });

    if (result.kind === "not_found") {
      return errorResponse(404, "NOT_FOUND", "Membership not found");
    }
    if (result.kind === "last_admin") {
      return errorResponse(
        409,
        "LAST_ADMIN",
        "Cannot remove the last admin of the team",
      );
    }
    // 204 would be more semantically correct for a successful delete, but the
    // rest of this codebase favors a small JSON ack so the client can branch
    // on a consistent shape. Stick with that pattern.
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err: unknown) {
    console.error(
      "[DELETE /api/teams/[teamId]/members/[userId]] unexpected error",
      err,
    );
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to remove member at this time",
    );
  }
}
