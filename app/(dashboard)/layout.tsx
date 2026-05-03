import type { ReactNode } from "react";

/**
 * Dashboard route group layout. Kept intentionally lightweight — feature
 * tasks own the actual chrome (sidebar, header, etc.). This layout exists
 * so the dashboard route group is a valid Next.js segment and so the
 * sibling `error.tsx` boundary scopes correctly.
 */
export default function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <div className="min-h-screen">{children}</div>;
}
