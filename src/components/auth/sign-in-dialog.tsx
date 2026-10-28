"use client"

import Link from "next/link"
import { BrandMark } from "@/components/brand-mark"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button"
import { DesktopSignIn } from "@/components/auth/desktop-sign-in"
import { useAuth } from "@/components/auth/auth-provider"
import { useIsDesktop } from "@/hooks/use-is-desktop"

/**
 * Hubble's own sign-in surface: Hubble's mark, Hubble's wording, and
 * exactly one third-party element — Google's official button, which
 * Google's branding terms require to be theirs.
 *
 * There is no authentication-provider branding here beyond that button, and
 * nothing anywhere in the app says whose infrastructure runs the accounts,
 * because it is Hubble's: the session, the user record and every
 * authorization decision belong to this app (see src/lib/auth/).
 *
 * The copy is deliberate about what signing in does and doesn't do. Hubble
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
  // Hubble Desktop can't host Google's button (its origin isn't one Google
  // accepts); it signs in through the browser instead.
  const desktop = useIsDesktop()

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
            <BrandMark />
            <span className="text-body font-medium tracking-tight">Hubble</span>
          </span>
          <DialogTitle>Sign in to Hubble</DialogTitle>
          <DialogDescription>
            {desktop
              ? "Approve Hubble Desktop in your browser, where you use Hubble. Links and titles then sync with your account."
              : "Signing in keeps your projects separate from anyone else on this browser."}
          </DialogDescription>
        </DialogHeader>

        {desktop ? (
          <DesktopSignIn onDone={() => onOpenChange(false)} />
        ) : (
          <div className="flex flex-col items-center gap-4 py-2">
            <GoogleSignInButton onCredential={handleCredential} />
          </div>
        )}

        <p className="text-center text-meta text-tertiary">
          By continuing you agree to Hubble&apos;s{" "}
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
