import "server-only";

/**
 * Module augmentation for next-auth so the JWT and User both expose the
 * multi-tenant fields we set in the auth callbacks. Importing this file is
 * not required at the call site — TypeScript merges these declarations into
 * the module graph as long as the file is included by `tsc`.
 *
 * We extend `User` (which is what `session.user` widens to via
 * `DefaultSession`) and the JWT payload. That keeps the public type surface
 * minimal: callers see `session.user.tenantId?: string` and
 * `session.user.role?: "admin" | "member"`, mirroring the optional shape of
 * the underlying token claims.
 */

declare module "next-auth" {
  interface User {
    tenantId?: string;
    role?: "admin" | "member";
  }
}

// `next-auth/jwt` re-exports from `@auth/core/jwt`; TypeScript module
// augmentation needs to target the package that actually *declares* the
// interface, otherwise the merge is a no-op (and tsc errors out on the
// re-export path because the subpath isn't part of the typings rootDir).
declare module "@auth/core/jwt" {
  interface JWT {
    tenantId?: string;
    role?: "admin" | "member";
  }
}

export {};
