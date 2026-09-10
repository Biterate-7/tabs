"use client"

import Link from "next/link"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button"
import { useAuth } from "@/components/auth/auth-provider"

/**
 * TabDump's own sign-in surface: TabDump's mark, TabDump's wording, and
 * exactly one third-party element — Google's official button, which
 * Google's branding terms require to be theirs.
 *
 * There is no authentication-provider branding here beyond that button, and
 * nothing anywhere in the app says whose infrastructure runs the accounts,
 * because it is TabDump's: the session, the user record and every
 * authorization decision belong to this app (see src/lib/auth/).
 *
 * The copy is deliberate about what signing in does and doesn't do. TabDump
 * is local-first — signing in does not upload anyone's tabs — so promising
 * sync here would be a lie the storage layer doesn't back up.
 */
export function SignInDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { completeGoogleSignIn } = useAuth()

  async function handleCredential(credential: string): Promise<string | null> {
    const result = await completeGoogleSignIn(credential)
    if (!result.ok) return result.error.message
    // A successful sign-in changes the active storage namespace, which
    // re-keys and unmounts this whole subtree — so closing the dialog here
    // is belt-and-braces for the case where the namespace didn't actually
    // change (signing back into the account already in use).
    onOpenChange(false)
    return null
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <span className="flex items-center gap-2 text-foreground">
            <span className="text-body font-semibold tracking-tight">TabDump</span>
          </span>
          <DialogTitle>Sign in to TabDump</DialogTitle>
          <DialogDescription>
            Your workspaces stay on this device — signing in keeps them yours, separate from anyone
            else who uses this browser.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4 py-2">
          <GoogleSignInButton onCredential={handleCredential} />
        </div>

        <p className="text-center text-meta text-tertiary">
          By continuing you agree to TabDump&apos;s{" "}
          <Link href="/terms" className="underline underline-offset-4 hover:text-foreground">
            Terms
          </Link>{" "}
          and{" "}
          <Link href="/privacy" className="underline underline-offset-4 hover:text-foreground">
            Privacy Policy
          </Link>
          .
        </p>
      </DialogContent>
    </Dialog>
  )
}
