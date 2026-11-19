"use client"

import { BrandMark } from "@/components/brand-mark"
import { AuthProvider, useAuth } from "@/components/auth/auth-provider"
import { ConnectedDesktops } from "@/components/auth/connected-desktops"
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"

/**
 * `/account` — the one account page the website keeps now that Hubble runs
 * as a desktop app.
 *
 * Signing in to Hubble Desktop happens through the browser
 * (`/desktop/connect`), so the website is also where a Hubble Desktop that is
 * lost, sold or no longer yours is disconnected: Disconnect deletes its
 * device credential (src/lib/auth/device.ts) and that app is signed out on
 * its next request. Projects are never on this page — they live in the app.
 */
export function AccountPage() {
  return (
    <AuthProvider>
      <main className="flex min-h-screen items-start justify-center bg-background px-4 py-16 sm:items-center">
        <div className="w-full max-w-lg rounded-lg border border-border bg-card px-6 py-6">
          <a href="/" className="flex items-center gap-2 text-foreground">
            <BrandMark />
            <span className="text-body font-medium tracking-tight">Hubble</span>
          </a>
          <AccountBody />
        </div>
      </main>
    </AuthProvider>
  )
}

function AccountBody() {
  const auth = useAuth()
  if (auth.status === "loading") return null
  if (!auth.configured) {
    return <p className="mt-6 text-body text-muted-foreground">Accounts aren&rsquo;t available on this site.</p>
  }
  if (!auth.user) {
    return (
      <div className="mt-6">
        <h1 className="text-title text-foreground">Your Hubble account</h1>
        <p className="mt-2 text-body text-muted-foreground">Sign in to see the Hubble Desktop apps connected to your account, and disconnect any you no longer use.</p>
        <div className="mt-5 flex justify-center">
          <GoogleSignInButton
            onCredential={async (credential) => {
              const result = await auth.completeGoogleSignIn(credential)
              return result.ok ? null : result.error.message
            }}
          />
        </div>
      </div>
    )
  }
  return (
    <div className="mt-6">
      <h1 className="text-title text-foreground">Your Hubble account</h1>
      <p className="mt-1 text-body text-muted-foreground">{auth.user.email}</p>
      <h2 className="mt-6 text-body font-medium text-foreground">Hubble Desktop on your computers</h2>
      <p className="mt-1 text-body-sm text-muted-foreground">Disconnect one to sign it out. Its projects stay on that computer.</p>
      <div className="mt-3 flex flex-col gap-2">
        <ConnectedDesktops empty={<p className="text-body-sm text-muted-foreground">No Hubble Desktop is signed in to this account.</p>} />
      </div>
      <div className="mt-6 border-t border-border pt-4">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={auth.signingOut}
          onClick={async () => {
            const result = await auth.signOut()
            if (!result.ok) toast.error(result.error.message)
          }}
        >
          {auth.signingOut ? "Signing out…" : "Sign out of this website"}
        </Button>
      </div>
    </div>
  )
}
