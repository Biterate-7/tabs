"use client"

import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import { toast } from "sonner"
import { BringLocalDataDialog } from "@/components/auth/bring-local-data-dialog"
import {
  exchangeGoogleCredential,
  fetchAuthState,
  signOutRequest,
  type AuthRequestError,
} from "@/lib/auth/client"
import { publicGoogleClientId } from "@/lib/auth/public-config"
import type { PublicUser } from "@/lib/auth/types"
import {
  copyAnonymousDataInto,
  hasAnonymousData,
  hasNamespaceData,
  setStorageNamespace,
} from "@/lib/storage/namespace"
import { loadAnonymousWorkspaceStore } from "@/lib/workspace/persistence"

/**
 * Owns TabDump's client-side view of "who is signed in", and — because
 * TabDump keeps its data locally — decides which local namespace the rest
 * of the app reads from.
 *
 * Three states, never collapsed into a boolean: `loading` is genuinely
 * distinct from `unauthenticated`, and rendering the signed-out shell while
 * the answer is still in flight is how an app flashes a login prompt at
 * someone who is already signed in.
 *
 * The server session is the only source of truth. This provider asks
 * /api/auth/me on every mount rather than trusting anything a previous
 * render or a previous tab believed — a session can have expired or been
 * revoked since.
 */

export type AuthStatus = "loading" | "authenticated" | "unauthenticated"

export type AuthContextValue = {
  status: AuthStatus
  user: PublicUser | null
  /** False when this deployment has no Google client ID or no account store — sign-in is hidden entirely rather than offered and then failing. */
  configured: boolean
  /** True while a sign-out request is in flight, so the menu can disable itself instead of double-submitting. */
  signingOut: boolean
  /** Completes a sign-in from a verified Google credential. Resolves to the error the server reported, if any. */
  completeGoogleSignIn: (
    credential: string
  ) => Promise<{ ok: true; user: PublicUser; created: boolean } | { ok: false; error: AuthRequestError }>
  signOut: () => Promise<{ ok: true } | { ok: false; error: AuthRequestError }>
  /** Re-reads /api/auth/me. For anything that needs to re-check the session without a reload. */
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

/** Strict accessor for components that only ever render inside the provider. */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used within AuthProvider")
  return ctx
}

/**
 * Same context, without the throw — mirroring
 * useOptionalAppearanceContext(). Components that show account UI as a
 * progressive enhancement use this, so they still render (as nothing) in
 * unit tests that mount them without a provider.
 */
export function useOptionalAuth(): AuthContextValue | null {
  return useContext(AuthContext)
}

type State =
  | { status: "loading" }
  | { status: "authenticated"; user: PublicUser }
  | { status: "unauthenticated"; configured: boolean }

/** What the one-time "bring your signed-out workspaces in?" offer needs to describe itself. */
type AdoptionOffer = { userId: string; workspaceCount: number }

/**
 * When no client ID is baked into the bundle, accounts are impossible on
 * this deployment — there is nothing for /api/auth/me to tell us. Starting
 * in the resolved state means such a deployment makes no auth request at
 * all and behaves exactly as TabDump did before accounts existed.
 */
function initialState(): State {
  return publicGoogleClientId() ? { status: "loading" } : { status: "unauthenticated", configured: false }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(initialState)
  const [signingOut, setSigningOut] = useState(false)
  const [remountToken, setRemountToken] = useState(0)
  const [adoptionOffer, setAdoptionOffer] = useState<AdoptionOffer | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    const result = await fetchAuthState(signal)
    if (signal?.aborted) return
    setState(
      result.authenticated && result.user
        ? { status: "authenticated", user: result.user }
        : { status: "unauthenticated", configured: result.configured }
    )
  }, [])

  useEffect(() => {
    if (!publicGoogleClientId()) return
    const controller = new AbortController()
    // A failed check resolves to signed-out inside fetchAuthState, so this
    // can never leave the app stuck on `loading`.
    // `.catch` rather than bare `void`: fetchAuthState rethrows on abort
    // (see below), and this caller cancels on unmount.
    //
    // The disable is the "synchronize with an external system on mount"
    // case effects exist for — the same reasoning (and the same directive)
    // as AppShell's own hydrate-on-mount effect. There is no way to derive
    // "is this browser signed in?" during render: it lives on the server.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(controller.signal).catch(() => {})
    return () => controller.abort()
  }, [load])

  const completeGoogleSignIn = useCallback<AuthContextValue["completeGoogleSignIn"]>(async (credential) => {
    const result = await exchangeGoogleCredential(credential)
    if (!result.ok) return result
    setState({ status: "authenticated", user: result.user })
    return { ok: true, user: result.user, created: result.created }
  }, [])

  const signOut = useCallback<AuthContextValue["signOut"]>(async () => {
    setSigningOut(true)
    try {
      const result = await signOutRequest()
      // Local state is cleared only after the server confirms the session
      // row is gone. Clearing it first would show a signed-out UI over a
      // session that is still live — the exact half-logout this avoids.
      if (result.ok) {
        // Clears Google's own "remember this account" hint, so the next
        // sign-in shows the account chooser instead of silently reusing the
        // account just signed out of. Read off `window` rather than
        // imported, so signing out never pulls in the GIS script for a
        // session that was restored from a cookie without it.
        window.google?.accounts?.id?.disableAutoSelect?.()
        setState({ status: "unauthenticated", configured: true })
      }
      return result
    } finally {
      setSigningOut(false)
    }
  }, [])

  const namespace = state.status === "authenticated" ? state.user.id : null

  /**
   * The namespace this component has already applied. React's documented
   * "adjust state when a prop changes" pattern: comparing it against the
   * namespace derived from `state` gives an edge trigger for the switch,
   * during render.
   *
   * During render, not in an effect, and this is load-bearing twice over:
   *
   * - The persistence modules read the active namespace synchronously
   *   inside the app shell's own mount effect, and in React a child's
   *   effects run BEFORE its parent's — a parent effect would always be too
   *   late, and the shell would hydrate from the previous account.
   * - "Is this account's namespace empty?" is only true *before* the
   *   re-keyed shell mounts, because the first thing it does is write a
   *   default workspace store into whatever namespace is active. By the
   *   time any effect could ask, the answer has already changed.
   *
   * The `undefined` starting value (distinct from the `null` that means
   * signed out) is what makes the very first render apply its namespace too.
   */
  const [appliedNamespace, setAppliedNamespace] = useState<string | null | undefined>(undefined)

  // Client-only, and that guard is load-bearing rather than defensive:
  // setStorageNamespace writes a module-level global, and on the server a
  // module is shared by every concurrent request. Today this is only ever
  // reached with `null` during SSR (the sole route to `authenticated` is a
  // browser fetch), so nothing leaks — but "safe because of a fact about a
  // different file" is exactly the invariant that quietly stops holding.
  // Skipping it on the server costs nothing: local storage only exists in
  // the browser, and the hydration render runs this block again.
  if (typeof window !== "undefined" && appliedNamespace !== namespace) {
    setAppliedNamespace(namespace)
    setStorageNamespace(namespace)
    setAdoptionOffer(
      namespace && hasAnonymousData() && !hasNamespaceData(namespace)
        ? { userId: namespace, workspaceCount: loadAnonymousWorkspaceStore()?.workspaces.length ?? 0 }
        : null
    )
  }

  function acceptAdoption() {
    if (!adoptionOffer) return
    const { copied, failed } = copyAnonymousDataInto(adoptionOffer.userId)
    setAdoptionOffer(null)

    if (failed.length > 0) {
      toast.error("Couldn't bring everything across", {
        description: "This browser's storage is full or unavailable. Your signed-out data is untouched.",
      })
    }
    if (copied.length === 0) return

    toast.success("Your workspaces are in your account")
    // The shell hydrated from the (then empty) account namespace moments
    // ago; remounting is what makes it re-read what was just copied in.
    setRemountToken((n) => n + 1)
  }

  const value = useMemo<AuthContextValue>(
    () => ({
      status: state.status,
      user: state.status === "authenticated" ? state.user : null,
      // While loading, assume accounts exist — the only way to be in that
      // state at all is a client ID being present in the bundle.
      configured: state.status === "unauthenticated" ? state.configured : true,
      signingOut,
      completeGoogleSignIn,
      signOut,
      refresh: () => load(),
    }),
    [state, signingOut, completeGoogleSignIn, signOut, load]
  )

  return (
    <AuthContext.Provider value={value}>
      {state.status === "loading" ? null : (
        // Keyed by namespace so switching accounts (or signing out) tears
        // the app shell down and rebuilds it. The shell hydrates from local
        // storage exactly once, on mount; remounting is what makes it
        // re-read from the newly active namespace instead of continuing to
        // show the previous account's workspaces.
        <Fragment key={`${namespace ?? "anonymous"}:${remountToken}`}>{children}</Fragment>
      )}

      {/* Deliberately OUTSIDE the keyed subtree. The sign-in that triggers
          this offer is what changes the key, so a dialog living inside
          would be unmounted by its own trigger before it could open. */}
      <BringLocalDataDialog
        open={adoptionOffer !== null}
        onOpenChange={(open) => {
          if (!open) setAdoptionOffer(null)
        }}
        onConfirm={acceptAdoption}
        workspaceCount={adoptionOffer?.workspaceCount ?? 0}
      />
    </AuthContext.Provider>
  )
}
