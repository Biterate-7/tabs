"use client"

import { useRef, useState } from "react"
import Link from "next/link"
import { ArrowUpRight, ChevronRight, Download, LogIn, LogOut, RotateCcw, Upload } from "lucide-react"
import { toast } from "sonner"
import { Button, buttonVariants } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Badge } from "@/components/ui/badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { SignInDialog } from "@/components/auth/sign-in-dialog"
import { ConnectedDesktops } from "@/components/auth/connected-desktops"
import { useOptionalAuth } from "@/components/auth/auth-provider"
import { useAppearanceContext } from "@/components/appearance-provider"
import { EXTENSION_INSTALL_STEPS } from "@/components/extension-install-guide"
import { RenameWorkspaceDialog } from "@/components/workspace/rename-workspace-dialog"
import { DeleteWorkspaceDialog } from "@/components/workspace/delete-workspace-dialog"
import { ProjectIcon } from "@/components/workspace/project-icon"
import { EXTENSION_DOWNLOAD_URL } from "@/lib/extension-config"
import { getOnboardingState } from "@/lib/onboarding"
import { useIsDesktop } from "@/hooks/use-is-desktop"
import { modKeyLabel } from "@/lib/keyboard"
import type { Workspace } from "@/lib/workspace/types"
import { FieldRow, GroupLabel, SectionHeading, SectionStack } from "./section-ui"

/*
 * The settings panes that are not appearance and not a single connector.
 *
 * Every row below reports something the product actually does or offers a
 * control it already has; none of them is a placeholder. (Desktop app has a
 * file of its own, ./desktop-section.tsx.) Each pane is a title and its rows; a
 * row's description is one short line, kept only where it says something
 * about data or permissions that the label cannot.
 */

// ---------------------------------------------------------------- Account

export function AccountSettingsSection() {
  const auth = useOptionalAuth()
  const [signInOpen, setSignInOpen] = useState(false)
  const isDesktop = useIsDesktop()

  const configured = Boolean(auth?.configured)
  const user = auth?.status === "authenticated" ? auth.user : null

  async function signOut() {
    const result = await auth?.signOut()
    if (result && !result.ok) toast.error(result.error.message)
  }

  return (
    <div>
      <SectionHeading title="Account" />
      <SectionStack>
        {user ? (
          <FieldRow label={user.name} description={user.email}>
            <Button type="button" variant="outline" size="sm" disabled={auth?.signingOut} onClick={() => void signOut()}>
              <LogOut /> {auth?.signingOut ? "Signing out…" : "Sign out"}
            </Button>
          </FieldRow>
        ) : (
          <FieldRow
            label="Not signed in"
            description={
              configured
                ? "Sign in to sync projects and use AI connectors."
                : "Accounts aren't available here."
            }
          >
            {configured && (
              <Button type="button" size="sm" onClick={() => setSignInOpen(true)}>
                <LogIn /> Sign in
              </Button>
            )}
          </FieldRow>
        )}
        <FieldRow
          label="Storage"
          description={
            user
              ? "Links and titles sync to your account. Conversation text and notes stay on this device."
              : isDesktop
                ? "Everything is saved in this app on this computer."
                : "Everything is saved in this browser."
          }
        >
          <Badge variant={user ? "success" : "default"}>{user ? "Synced" : "Local"}</Badge>
        </FieldRow>
        {/* The web manages connected desktops; the app signs only itself out. */}
        {user && !isDesktop && <ConnectedDesktops />}
      </SectionStack>
      <SignInDialog open={signInOpen} onOpenChange={setSignInOpen} />
    </div>
  )
}

// -------------------------------------------------------------- Extension

/** Settings → Chrome extension: whether it is connected, what it reads, and how to install it. */
export function ExtensionSection() {
  const isDesktop = useIsDesktop()
  // The website hears from the extension through the page; Hubble Desktop never does (Chrome reaches it over its own
  // local bridge), so there it says how to send tabs instead of a status that could only ever read "Not connected".
  const connected = !isDesktop && getOnboardingState().extensionConnected
  return (
    <div>
      <SectionHeading title="Chrome extension" />
      <SectionStack className="mb-6">
        <FieldRow
          label="Hubble for Chrome"
          description={
            isDesktop
              ? "Sends tabs here: in Chrome, right-click a tab → Hubble → Add to Hubble Desktop. Save to Hubble on an AI chat saves here while this app is open."
              : "Save tabs and AI conversations from Chrome."
          }
        >
          <span className="flex items-center gap-2">
            {!isDesktop && <Badge variant={connected ? "success" : "default"}>{connected ? "Connected" : "Not connected"}</Badge>}
            <a href={EXTENSION_DOWNLOAD_URL} download className={buttonVariants({ size: "sm", variant: connected ? "outline" : "default" })}>
              <Download /> Download
            </a>
          </span>
        </FieldRow>
        <FieldRow
          label="What it reads"
          description="What you send: tab titles and addresses, and a conversation's visible text when you choose Save to Hubble. With context detection on (Settings → Context), also the addresses and titles of pages you use, and — only for AI apps you allow — topic words from open chats. Never cookies, passwords or what you type."
        >
          <span />
        </FieldRow>
      </SectionStack>
      <details className="group">
        <summary className="mb-2 flex w-fit cursor-pointer list-none items-center gap-1 text-label text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
          <ChevronRight aria-hidden className="size-3.5 transition-transform group-open:rotate-90" /> Install steps
        </summary>
        <SectionStack>
          {EXTENSION_INSTALL_STEPS.map((step, i) => (
            <div key={i} className="flex gap-3 px-4 py-2.5 text-body text-muted-foreground">
              <span className="w-4 shrink-0 text-meta leading-5 text-tertiary tabular-nums">{i + 1}</span>
              <span>{step}</span>
            </div>
          ))}
        </SectionStack>
      </details>
    </div>
  )
}

// ------------------------------------------------------------- Workspaces

export type WorkspaceSettingsProps = {
  workspaces: Workspace[]
  currentId: string
  onSwitch: (id: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  onUpdateLogo: (id: string, logo: string | undefined) => void
  /** Imports projects from a Hubble export (.json). */
  onImportFile?: (text: string) => void
}

/** Settings → Projects: every project (workspace) on this device — open, rename, remove, import. */
export function WorkspacesSection({ workspaces, currentId, onSwitch, onRename, onDelete, onUpdateLogo, onImportFile }: WorkspaceSettingsProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const renaming = workspaces.find((w) => w.id === renameId)
  const deleting = workspaces.find((w) => w.id === deleteId)

  return (
    <div>
      <SectionHeading title="Projects" />
      <SectionStack>
        {workspaces.map((w) => (
          <div key={w.id} className="flex min-h-12 items-center gap-3 px-4 py-2.5">
            <ProjectIcon workspace={w} size={20} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-body text-foreground">{w.name}</p>
              <p className="text-meta text-tertiary">
                {w.tabs.length + (w.notes?.length ?? 0)} item{w.tabs.length + (w.notes?.length ?? 0) === 1 ? "" : "s"}
              </p>
            </div>
            {w.id !== currentId && (
              <Button type="button" variant="ghost" size="sm" onClick={() => onSwitch(w.id)}>
                Open
              </Button>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={() => setRenameId(w.id)}>
              Rename
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={workspaces.length <= 1}
              onClick={() => setDeleteId(w.id)}
            >
              Delete
            </Button>
          </div>
        ))}
      </SectionStack>
      {onImportFile && (
        <>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => fileInputRef.current?.click()}>
            <Upload /> Import projects…
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            aria-label="Import projects from a Hubble export file"
            onChange={async (event) => {
              const file = event.target.files?.[0]
              event.target.value = ""
              if (file) onImportFile(await file.text())
            }}
          />
        </>
      )}
      {renaming && (
        <RenameWorkspaceDialog
          key={renaming.id}
          open
          onOpenChange={(open) => !open && setRenameId(null)}
          currentName={renaming.name}
          onRename={(name) => onRename(renaming.id, name)}
          logo={renaming.logo}
          onLogoChange={(logo) => onUpdateLogo(renaming.id, logo)}
        />
      )}
      {deleting && (
        <DeleteWorkspaceDialog
          open
          onOpenChange={(open) => !open && setDeleteId(null)}
          workspaceName={deleting.name}
          tabCount={deleting.tabs.length}
          onConfirm={() => {
            setDeleteId(null)
            onDelete(deleting.id)
          }}
        />
      )}
    </div>
  )
}

// -------------------------------------------------------------- Shortcuts

export function ShortcutsSection() {
  const mod = modKeyLabel()
  const groups: { label: string; items: { keys: string[]; description: string }[] }[] = [
    {
      label: "Everywhere",
      items: [
        { keys: [mod, "K"], description: "Search and run commands" },
        { keys: ["Esc"], description: "Close the palette or a dialog" },
      ],
    },
    {
      label: "Saved tabs",
      items: [
        { keys: ["/"], description: "Search tabs" },
        { keys: ["↑", "↓"], description: "Move through results" },
        { keys: ["Enter"], description: "Open the highlighted tab" },
        { keys: [mod, "A"], description: "Select all (in selection mode)" },
        { keys: ["Esc"], description: "Exit selection, then clear the search" },
      ],
    },
  ]
  return (
    <div>
      <SectionHeading title="Shortcuts" />
      {groups.map((group) => (
        <div key={group.label} className="mb-6">
          <GroupLabel>{group.label}</GroupLabel>
          <SectionStack>
            {group.items.map((item) => (
              <div key={item.description} className="flex min-h-10 items-center justify-between gap-4 px-4 py-2">
                <span className="text-body text-foreground">{item.description}</span>
                <span className="flex items-center gap-1">
                  {item.keys.map((key) => (
                    <Kbd key={key}>{key}</Kbd>
                  ))}
                </span>
              </div>
            ))}
          </SectionStack>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- Privacy

const LEGAL_LINKS = [
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/terms", label: "Terms & Conditions" },
  { href: "/cookies", label: "Cookie Policy" },
] as const

export function PrivacySection() {
  return (
    <div>
      <SectionHeading title="Privacy" />
      <SectionStack className="mb-6">
        <FieldRow label="Local first" description="Projects, conversations, notes and page text are stored on this device.">
          <span />
        </FieldRow>
        <FieldRow
          label="Saving from AI apps"
          description="A conversation's text is saved only when you choose Save to Hubble or accept a suggestion. For AI apps you allow in Settings → Context, Hubble for Chrome also reads open chats to keep their topic words for matching — never the text. Hubble never signs in to an AI app or reads your passwords or cookies."
        >
          <span />
        </FieldRow>
        <FieldRow
          label="Reading web pages"
          description="A page's address is sent to Hubble's reader, which fetches the public page. Conversations and notes are never sent."
        >
          <span />
        </FieldRow>
        <FieldRow
          label="Context detection"
          description="Off until you choose. When on, Hubble for Chrome keeps the addresses, titles and times of pages you use — in this browser, never sent — and Hubble suggests projects from them on this device. Sensitive sites and private windows are always skipped. Change it, pause it or clear it in Settings → Context."
        >
          <span />
        </FieldRow>
        <FieldRow label="Using context in an AI chat" description="You choose what goes in. Hubble for Chrome puts it in a new chat for you to review, or you copy it — it is sent only when you choose Send automatically. The AI app receives only that message and any files you attach.">
          <span />
        </FieldRow>
      </SectionStack>
      <GroupLabel>Legal</GroupLabel>
      <SectionStack>
        {LEGAL_LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="flex min-h-10 items-center justify-between px-4 py-2 text-body text-foreground transition-colors duration-(--duration-fast) hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            {link.label}
            <ArrowUpRight className="size-3.5 text-tertiary" aria-hidden />
          </Link>
        ))}
      </SectionStack>
    </div>
  )
}

// --------------------------------------------------------------- Advanced

export function AdvancedSection() {
  const { resetAllAppearance } = useAppearanceContext()
  return (
    <div>
      <SectionHeading title="Diagnostics" />
      <SectionStack>
        <FieldRow
          label="Reset appearance"
          description="Back to the default look. Projects are untouched."
        >
          <AlertDialog>
            <AlertDialogTrigger render={<Button type="button" variant="outline" size="sm" />}>
              <RotateCcw /> Reset
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Reset all appearance settings?</AlertDialogTitle>
                <AlertDialogDescription>
                  This puts theme, typography, background, layout, shape, motion, and accent back to their defaults. This
                  cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => resetAllAppearance()}>
                  Reset
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </FieldRow>
      </SectionStack>
    </div>
  )
}
