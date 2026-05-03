import type { ReactNode } from "react";
import Link from "next/link";

/**
 * Centered card shell used by every page in the (auth) route group
 * (login, register, password reset, etc.). Provides a fixed-width column
 * with a brand mark above the card so individual pages only need to render
 * their own <Card> contents.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-md space-y-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-lg font-semibold tracking-tight"
            aria-label="Go to home"
          >
            <span
              aria-hidden="true"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground text-sm font-bold"
            >
              ◈
            </span>
            <span>Workspace</span>
          </Link>
        </div>
        {children}
      </div>
    </main>
  );
}
