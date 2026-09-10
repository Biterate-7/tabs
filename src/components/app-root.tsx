"use client"

import { AppShell } from "@/components/app-shell"
import { AuthProvider } from "@/components/auth/auth-provider"

/**
 * The client boundary between the route and the app.
 *
 * AppShell is wrapped rather than modified: AuthProvider decides which
 * local storage namespace is active and re-keys the shell when that
 * changes, so signing in or out re-hydrates the whole app from the right
 * account's data without AppShell itself knowing accounts exist. That
 * separation is also what keeps every existing AppShell test — which mount
 * it directly, with no provider — working unchanged.
 */
export function AppRoot() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  )
}
