"use client";

import { useEffect } from "react";

type DashboardErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

/**
 * Error boundary scoped to the (dashboard) route group. Catches errors
 * thrown anywhere inside dashboard pages so the user can recover without
 * losing the surrounding shell (when feature tasks add it).
 */
export default function DashboardError({
  error,
  reset,
}: DashboardErrorProps) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error("[(dashboard)/error] Uncaught error:", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mx-auto max-w-md space-y-5">
        <div className="space-y-2">
          <p className="text-sm font-medium uppercase tracking-wide text-destructive">
            Dashboard error
          </p>
          <h2 className="text-2xl font-semibold tracking-tight">
            We couldn&apos;t load this page
          </h2>
          <p className="text-muted-foreground">
            Something went wrong while rendering the dashboard. You can retry
            this view without leaving your session.
          </p>
        </div>

        {process.env.NODE_ENV !== "production" && error?.message ? (
          <pre className="overflow-auto rounded-md border border-border bg-muted p-3 text-left text-xs text-muted-foreground">
            {error.message}
            {error.digest ? `\n\ndigest: ${error.digest}` : null}
          </pre>
        ) : null}

        <div className="flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => reset()}
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Retry
          </button>
          <a
            href="/"
            className="inline-flex h-10 items-center justify-center rounded-md border border-border bg-background px-4 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}
