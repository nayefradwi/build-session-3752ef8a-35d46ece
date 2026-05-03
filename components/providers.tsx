"use client";

import type { ReactNode } from "react";
import type { Session } from "next-auth";
import { SessionProvider } from "next-auth/react";
import { Toaster } from "sonner";

type ProvidersProps = {
  children: ReactNode;
  /**
   * Session resolved on the server (via `auth()`) and forwarded into the
   * `SessionProvider` so client components can read `useSession()` without an
   * extra `/api/auth/session` fetch on hydration. Pass `null` for visitors.
   */
  session?: Session | null;
};

/**
 * Top-level client providers.
 *
 *  - `SessionProvider` lets client components call `useSession()` for
 *    role-based UI gating (e.g. the admin-only invitations page) without
 *    re-fetching the session via the network.
 *  - `Toaster` mounts sonner's portal so `toast.success()` / `toast.error()`
 *    calls from anywhere in the tree actually render. Mounted once at the
 *    root so every route — auth pages and dashboard alike — has toasts.
 */
export function Providers({ children, session }: ProvidersProps) {
  return (
    <SessionProvider session={session}>
      {children}
      <Toaster richColors position="top-right" closeButton />
    </SessionProvider>
  );
}
