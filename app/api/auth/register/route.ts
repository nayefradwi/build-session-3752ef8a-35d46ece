import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { tenants, users } from "@/lib/db/schema";
import { hashPassword } from "@/lib/server/auth/password";
import { registerInputSchema } from "@/lib/server/auth/register-schema";

// Always treat as dynamic: this handler reads the request body and writes to
// the database, so prerender / cache modes must not apply.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RegisterErrorCode =
  | "INVALID_JSON"
  | "INVALID_INPUT"
  | "EMAIL_TAKEN"
  | "INTERNAL_ERROR";

const errorResponse = (
  status: number,
  code: RegisterErrorCode,
  message: string,
  details?: unknown,
): NextResponse =>
  NextResponse.json(
    details === undefined
      ? { error: message, code }
      : { error: message, code, details },
    { status },
  );

export async function POST(request: Request): Promise<NextResponse> {
  // 1. Parse JSON body. Malformed JSON should be a 400, not a 500.
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

  // 2. Validate shape & complexity rules.
  const parsed = registerInputSchema.safeParse(rawBody);
  if (!parsed.success) {
    return errorResponse(
      400,
      "INVALID_INPUT",
      "Validation failed",
      z.treeifyError(parsed.error),
    );
  }
  const { email, password, name, organizationName } = parsed.data;

  // 3. Pre-flight uniqueness check (cheap path — gives a clean 409 before we
  //    burn ~250 ms hashing). The transaction below still relies on the DB
  //    unique index for the race-condition path.
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing.length > 0) {
    return errorResponse(
      409,
      "EMAIL_TAKEN",
      "An account with this email already exists",
    );
  }

  // 4. Hash the password OUTSIDE the transaction so we don't hold a DB
  //    connection while bcrypt churns.
  const passwordHash = await hashPassword(password);

  // 5. Create tenant + admin user atomically.
  try {
    const result = await db.transaction(async (tx) => {
      const [tenant] = await tx
        .insert(tenants)
        .values({ name: organizationName })
        .returning({
          id: tenants.id,
          name: tenants.name,
          createdAt: tenants.createdAt,
        });

      const [user] = await tx
        .insert(users)
        .values({
          email,
          name,
          passwordHash,
          tenantId: tenant.id,
          role: "admin",
        })
        .returning({
          id: users.id,
          email: users.email,
          name: users.name,
          role: users.role,
          tenantId: users.tenantId,
          createdAt: users.createdAt,
        });

      return { tenant, user };
    });

    return NextResponse.json(
      {
        user: result.user,
        tenant: result.tenant,
      },
      { status: 201 },
    );
  } catch (err: unknown) {
    // Race-condition path: another request created a user with this email
    // between the pre-flight check and the insert. Postgres reports unique
    // violations with SQLSTATE 23505.
    const sqlState =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;
    if (sqlState === "23505") {
      return errorResponse(
        409,
        "EMAIL_TAKEN",
        "An account with this email already exists",
      );
    }
    console.error("[POST /api/auth/register] unexpected error", err);
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "Unable to create account at this time",
    );
  }
}
