"use client"

import { useEffect } from "react"
import { AppShell } from "@/components/app-shell"
import { AuthProvider } from "@/components/auth/auth-provider"
import { sweepRetiredStorage } from "@/lib/storage/retired"

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
  /*
    Clear storage that deleted features left behind.

    Here rather than inside AppShell for the same reason AuthProvider is:
    this is a one-shot startup concern that has nothing to do with rendering
    a workspace, and putting it in the shell would run it again on every
    account switch (which re-keys and remounts the shell).

    It runs *outside* the namespace, deliberately — retired keys are swept
    for every account in this browser, including ones nobody will sign into
    on this device. See lib/storage/retired.ts.
  */
  useEffect(() => {
    sweepRetiredStorage()
  }, [])

  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  )
}
