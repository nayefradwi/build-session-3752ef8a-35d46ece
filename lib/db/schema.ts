import { sql } from "drizzle-orm";
import {
  index,
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

// team-scoped role applied to team_memberships.role. Distinct from
// userRoleEnum so user-level and team-level roles can evolve independently.
export const teamRoleEnum = pgEnum("team_role", ["admin", "member"]);

// project visibility — "public" projects are visible to all members of the
// owning tenant, "private" projects are restricted to team members.
export const projectVisibilityEnum = pgEnum("project_visibility", [
  "public",
  "private",
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

// Teams: tenant-scoped collaboration units. A team belongs to a tenant and
// owns zero-or-more projects; users join teams via team_memberships.
export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Tenant-scoped listings ("show me my tenant's teams") are the dominant
    // read pattern; index the FK so the planner can range-scan by tenant.
    index("teams_tenant_id_idx").on(table.tenantId),
  ],
);

// Team memberships: many-to-many between users and teams with a per-team
// role. The composite PK (userId, teamId) enforces "a user joins a team at
// most once" at the database layer.
export const teamMemberships = pgTable(
  "team_memberships",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    role: teamRoleEnum("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.teamId],
      name: "team_memberships_user_id_team_id_pk",
    }),
    // The composite PK leads with userId, so "list a team's members" needs
    // its own index on teamId for efficient lookups.
    index("team_memberships_team_id_idx").on(table.teamId),
  ],
);

// Projects belong to a single team. Visibility gates whether non-team
// members of the same tenant can view the project.
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    visibility: projectVisibilityEnum("visibility")
      .notNull()
      .default("private"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // "List a team's projects" is the hot path — index the FK.
    index("projects_team_id_idx").on(table.teamId),
  ],
);

// Columns are ordered lanes within a project (kanban-style). `position` is
// an integer order key; the (projectId, position) pair is unique so two
// columns can't occupy the same slot.
export const columns = pgTable(
  "columns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull(),
  },
  (table) => [
    // Render-order queries always filter by projectId and sort by position.
    // A unique composite index serves both the ordering scan and the
    // "no two columns share a slot" invariant in one structure.
    uniqueIndex("columns_project_id_position_unique").on(
      table.projectId,
      table.position,
    ),
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
export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
export type TeamMembership = typeof teamMemberships.$inferSelect;
export type NewTeamMembership = typeof teamMemberships.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Column = typeof columns.$inferSelect;
export type NewColumn = typeof columns.$inferInsert;

// Tasks are work items that live inside a column. Title is required;
// description and assignee are optional. `position` is the integer order
// key within the column (no uniqueness constraint — UI is free to compact /
// re-balance positions when reordering, and transient ties are tolerated).
export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    columnId: uuid("column_id")
      .notNull()
      .references(() => columns.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    // Assignee is a tenant user. SET NULL on user delete so the task
    // survives the user's removal but becomes unassigned.
    assigneeId: uuid("assignee_id").references(() => users.id, {
      onDelete: "set null",
    }),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // "List a column's tasks ordered by position" is the dominant read
    // path; index the FK.
    index("tasks_column_id_idx").on(table.columnId),
    // "List tasks assigned to me" / per-user dashboards filter by
    // assigneeId, so it gets its own index.
    index("tasks_assignee_id_idx").on(table.assigneeId),
  ],
);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;

// Attachments are files uploaded against a task. We store the original
// filename for display, plus the on-disk path the upload handler wrote to.
// MIME type and size are recorded at upload time and surfaced on the task
// detail payload so clients can render previews without restating each file.
//
// Storage backend: local filesystem under `process.env.UPLOAD_DIR` (default
// `./uploads`). The `storagePath` column is opaque to callers — they must
// stream through the download route, never join a path on the client. When
// the storage driver moves to object storage (S3, etc.), only `storagePath`
// semantics change; the column stays as the canonical reference.
export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    // Original filename as supplied by the uploader (display only).
    filename: text("filename").notNull(),
    // Server-side path the upload was written to (relative to UPLOAD_DIR or
    // absolute, depending on how UPLOAD_DIR was configured). Opaque to clients.
    storagePath: text("storage_path").notNull(),
    mimeType: text("mime_type").notNull(),
    // Size in bytes. `integer` (32-bit signed) caps at ~2.1 GB which is well
    // above MAX_UPLOAD_SIZE_BYTES; if that ever changes, widen this column.
    size: integer("size").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // "List a task's attachments" is the dominant read pattern (task detail
    // payload includes them). Index the FK so the planner can range-scan.
    index("attachments_task_id_idx").on(table.taskId),
  ],
);

export type Attachment = typeof attachments.$inferSelect;
export type NewAttachment = typeof attachments.$inferInsert;

// Re-export `sql` so callers downstream can use raw expressions without
// re-importing drizzle-orm directly from the schema module.
export { sql };
