import { sql } from "drizzle-orm";
import {
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Multi-tenant data model.
 *
 *   tenants  ──< users
 *   users    ──< sessions   (NextAuth.js session table)
 *   users    ──< accounts   (NextAuth.js OAuth/credential account table)
 *   verificationTokens      (NextAuth.js email-verification table)
 *
 * Schema shape for the auth tables follows the canonical NextAuth.js
 * Drizzle adapter contract so the @auth/drizzle-adapter can be plugged in
 * without further migrations:
 *   https://authjs.dev/getting-started/adapters/drizzle
 */

// admin / member role enum applied to users.role. Default is "member".
export const userRoleEnum = pgEnum("user_role", ["admin", "member"]);

// invitation lifecycle: created (pending) -> accepted on signup.
export const invitationStatusEnum = pgEnum("invitation_status", [
  "pending",
  "accepted",
]);

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    // NextAuth.js stores the hashed verification timestamp here; for
    // credentials-style logins we use it as the verified-at marker.
    emailVerified: timestamp("email_verified", { withTimezone: true }),
    passwordHash: text("password_hash"),
    name: text("name"),
    image: text("image"),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    role: userRoleEnum("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Globally-unique email. Email is the login identifier across tenants;
    // a user belongs to exactly one tenant.
    uniqueIndex("users_email_unique").on(table.email),
  ],
);

// NextAuth.js: linked OAuth / credentials accounts for a user.
export const accounts = pgTable(
  "accounts",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refreshToken: text("refresh_token"),
    accessToken: text("access_token"),
    expiresAt: integer("expires_at"),
    tokenType: text("token_type"),
    scope: text("scope"),
    idToken: text("id_token"),
    sessionState: text("session_state"),
  },
  (table) => [
    primaryKey({
      columns: [table.provider, table.providerAccountId],
      name: "accounts_provider_provider_account_id_pk",
    }),
  ],
);

// NextAuth.js: server-side session records (used when strategy = "database").
export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
});

// NextAuth.js: email-verification challenge tokens.
export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.identifier, table.token],
      name: "verification_tokens_identifier_token_pk",
    }),
  ],
);

// Tenant invitations. An admin issues a token-bearing invite for an email
// address; the recipient redeems the token to join the tenant. Tokens are
// single-use UUIDs and expire after `expiresAt`.
export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    token: uuid("token").notNull().defaultRandom(),
    status: invitationStatusEnum("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    // Token is the lookup key during redemption; unique + indexed for O(log n)
    // lookups and to guarantee single-use semantics at the DB layer.
    uniqueIndex("invitations_token_unique").on(table.token),
  ],
);

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type VerificationToken = typeof verificationTokens.$inferSelect;
export type NewVerificationToken = typeof verificationTokens.$inferInsert;
export type Invitation = typeof invitations.$inferSelect;
export type NewInvitation = typeof invitations.$inferInsert;

// Re-export `sql` so callers downstream can use raw expressions without
// re-importing drizzle-orm directly from the schema module.
export { sql };
