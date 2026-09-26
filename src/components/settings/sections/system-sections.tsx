"use client"

import { useState } from "react"
import Link from "next/link"
import { ArrowUpRight, Download, LogIn, LogOut, RotateCcw } from "lucide-react"
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
import { useOptionalAuth } from "@/components/auth/auth-provider"
import { useAppearanceContext } from "@/components/appearance-provider"
import { EXTENSION_INSTALL_STEPS } from "@/components/extension-install-guide"
import { RenameWorkspaceDialog } from "@/components/workspace/rename-workspace-dialog"
import { DeleteWorkspaceDialog } from "@/components/workspace/delete-workspace-dialog"
import { WorkspaceAvatar } from "@/components/workspace/workspace-avatar"
import { EXTENSION_DOWNLOAD_URL } from "@/lib/extension-config"
import { getOnboardingState } from "@/lib/onboarding"
import { isDesktop } from "@/lib/platform/detect"
import { modKeyLabel } from "@/lib/keyboard"
import { useAgentConnectors } from "@/hooks/use-agent-connectors"
import { useProviderConnections } from "@/hooks/use-provider-connections"
import type { Workspace } from "@/lib/workspace/types"
import { ClaudeDesktopMcpCard } from "./claude-desktop-mcp-card"
import { ProviderConnectionCard } from "./provider-connection-card"
import { FieldRow, GroupBlock, GroupLabel, SectionHeading, SectionStack } from "./section-ui"

/*
 * The settings panes that are not appearance and not a single connector.
 *
 * Every row below reports something the product actually does or offers a
 * control it already has; none of them is a placeholder. Where a surface has
 * nothing configurable yet (Desktop, Browser), the pane says what is true of
 * this install instead of inventing a toggle.
 */

// ---------------------------------------------------------------- Account

export function AccountSettingsSection() {
  const auth = useOptionalAuth()
  const [signInOpen, setSignInOpen] = useState(false)

  const configured = Boolean(auth?.configured)
  const user = auth?.status === "authenticated" ? auth.user : null

  async function signOut() {
    const result = await auth?.signOut()
    if (result && !result.ok) toast.error(result.error.message)
  }

  return (
    <div>
      <SectionHeading title="Account" description="Your Hubble identity and where your workspaces are kept." />
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
                ? "Sign in to sync workspaces between devices and connect Claude Desktop."
                : "This deployment has no accounts configured. Everything stays on this device."
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
              ? "Workspaces are saved on this device first and synced to your account."
              : "Workspaces are saved in this browser's local storage."
          }
        >
          <Badge variant={user ? "success" : "default"}>{user ? "Synced" : "Local"}</Badge>
        </FieldRow>
      </SectionStack>
      <SignInDialog open={signInOpen} onOpenChange={setSignInOpen} />
    </div>
  )
}

// -------------------------------------------------------------- Providers

export function ProvidersSection() {
  const connections = useProviderConnections()
  const connectors = useAgentConnectors()

  return (
    <div>
      <SectionHeading
        title="Providers"
        description="Your own provider credentials. Sessions you start run on your account and your key — Hubble never shares one between users."
      />
      {connections.loading && <p className="text-body-sm text-tertiary">Loading…</p>}
      {!connections.loading && connections.unavailable && (
        <SectionStack>
          <GroupBlock>
            <p className="text-body-sm text-muted-foreground">
              This deployment cannot store provider credentials. Agents that sign in on their own (Claude Code,
              Gemini CLI) still work on this machine.
            </p>
          </GroupBlock>
        </SectionStack>
      )}
      {!connections.loading && !connections.unavailable && connections.connectable.length === 0 && (
        <SectionStack>
          <GroupBlock>
            <p className="text-body-sm text-muted-foreground">No provider on this deployment accepts a credential yet.</p>
          </GroupBlock>
        </SectionStack>
      )}
      <div className="flex flex-col gap-3">
        {connections.connectable.map((entry) => (
          <ProviderConnectionCard
            key={entry.provider}
            provider={entry.provider}
            providerName={connectors.view(entry.provider)?.descriptor.displayName ?? entry.provider}
            connection={connections.forProvider(entry.provider)}
            input={entry.input}
            unavailable={connections.unavailable}
            durable={connections.durable}
            busy={connections.busy}
            onConnect={connections.connect}
            onRotate={connections.rotate}
            onDisconnect={connections.disconnect}
          />
        ))}
      </div>
    </div>
  )
}

// -------------------------------------------------------------------- MCP

export function McpSection() {
  return (
    <div>
      <SectionHeading
        title="MCP"
        description="How agents reach your Hubble context. Every server here is read-only unless a session you approve says otherwise."
      />
      <GroupLabel>Agent sessions</GroupLabel>
      <SectionStack className="mb-6">
        <FieldRow
          label="Session context server"
          description="Each session you start gets its own short-lived Hubble server, bound to one workspace and revoked when the session ends. Hubble adds no other servers to a session."
        >
          <Badge variant="default">Per session</Badge>
        </FieldRow>
        <FieldRow
          label="Workspace changes"
          description="An agent can propose changes to a workspace. Nothing is applied until you approve it in the Command Centre."
        >
          <Badge variant="default">Approval required</Badge>
        </FieldRow>
      </SectionStack>
      <GroupLabel>Use Hubble from Claude Desktop</GroupLabel>
      <ClaudeDesktopMcpCard />
    </div>
  )
}

// ---------------------------------------------------------------- Browser

export function BrowserSection() {
  const connected = getOnboardingState().extensionConnected
  return (
    <div>
      <SectionHeading title="Browser" description="How Hubble reads your browser and opens what you saved." />
      <SectionStack>
        <FieldRow
          label="Extension"
          description={
            connected
              ? "The Hubble extension has delivered tabs to this workspace."
              : "Not connected yet. Without it, paste URLs or use History Dump."
          }
        >
          <Badge variant={connected ? "success" : "default"}>{connected ? "Connected" : "Not connected"}</Badge>
        </FieldRow>
        <FieldRow
          label="What Hubble reads"
          description="Only the tabs you send it — their titles and addresses. Never page contents, cookies or passwords."
        >
          <span />
        </FieldRow>
        <FieldRow label="Opening tabs" description="Saved tabs open in your browser, never inside Hubble.">
          <span />
        </FieldRow>
      </SectionStack>
    </div>
  )
}

// -------------------------------------------------------------- Extension

export function ExtensionSection() {
  return (
    <div>
      <SectionHeading title="Extension" description="Hubble for Chrome sends your open tabs to a workspace in one click." />
      <SectionStack className="mb-6">
        <FieldRow label="Hubble for Chrome" description="Unpacked extension for Chrome and other Chromium browsers">
          <a href={EXTENSION_DOWNLOAD_URL} download className={buttonVariants({ size: "sm" })}>
            <Download /> Download
          </a>
        </FieldRow>
      </SectionStack>
      <GroupLabel>Install</GroupLabel>
      <SectionStack>
        {EXTENSION_INSTALL_STEPS.map((step, i) => (
          <div key={i} className="flex gap-3 px-4 py-2.5 text-body text-muted-foreground">
            <span className="w-4 shrink-0 text-meta leading-5 text-tertiary tabular-nums">{i + 1}</span>
            <span>{step}</span>
          </div>
        ))}
      </SectionStack>
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
}

export function WorkspacesSection({ workspaces, currentId, onSwitch, onRename, onDelete, onUpdateLogo }: WorkspaceSettingsProps) {
  const [renameId, setRenameId] = useState<string | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const renaming = workspaces.find((w) => w.id === renameId)
  const deleting = workspaces.find((w) => w.id === deleteId)

  return (
    <div>
      <SectionHeading title="Workspaces" description="Every workspace on this device. Switch, rename or remove one here." />
      <SectionStack>
        {workspaces.map((w) => (
          <div key={w.id} className="flex min-h-12 items-center gap-3 px-4 py-2.5">
            <WorkspaceAvatar workspace={w} size={20} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-body text-foreground">{w.name}</p>
              <p className="text-meta text-tertiary">
                {w.tabs.length} tab{w.tabs.length === 1 ? "" : "s"}
                {w.id === currentId ? " · current" : ""}
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
      label: "Workspace",
      items: [
        { keys: ["/"], description: "Focus the tab search" },
        { keys: ["↑", "↓"], description: "Move through results" },
        { keys: ["Enter"], description: "Open the highlighted tab, or run a command" },
        { keys: [mod, "A"], description: "Select all visible tabs (in selection mode)" },
        { keys: ["Esc"], description: "Exit selection mode, then clear the search" },
      ],
    },
    {
      label: "Command Centre",
      items: [{ keys: ["Enter"], description: "Send the message in the composer" }],
    },
  ]
  return (
    <div>
      <SectionHeading title="Shortcuts" description="Every keyboard shortcut Hubble responds to." />
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

// ---------------------------------------------------------------- Desktop

export function DesktopSection() {
  const desktop = isDesktop()
  return (
    <div>
      <SectionHeading title="Desktop" description="Hubble Desktop is the same app with a local agent runtime built in." />
      <SectionStack>
        <FieldRow
          label="This install"
          description={
            desktop
              ? "You are running Hubble Desktop. Agents run on this machine, in projects you authorize."
              : "You are using Hubble in the browser. Agents need Hubble Desktop, or a deployment with a remote runtime."
          }
        >
          <Badge variant="default">{desktop ? "Desktop" : "Web"}</Badge>
        </FieldRow>
        <FieldRow
          label="Agent processes"
          description="Agents Hubble starts end with the app. Nothing keeps running after you quit."
        >
          <span />
        </FieldRow>
        <FieldRow
          label="Your data"
          description="Workspaces live in the app's own profile on this machine, separate from any browser."
        >
          <span />
        </FieldRow>
      </SectionStack>
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
      <SectionHeading title="Privacy" description="What Hubble keeps, where, and who can see it." />
      <SectionStack className="mb-6">
        <FieldRow label="Local first" description="Workspaces, tabs, notes and agent history are stored on this device.">
          <span />
        </FieldRow>
        <FieldRow
          label="Agent context"
          description="Agents see only the context you attach to a session. Page titles are passed as quoted reference material, never as instructions."
        >
          <span />
        </FieldRow>
        <FieldRow label="Credentials" description="Provider keys are yours alone and encrypted at rest; after you save one, Hubble shows only a short hint of it.">
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
      <SectionHeading title="Advanced" description="Resets and diagnostics." />
      <SectionStack>
        <FieldRow
          label="Reset appearance"
          description="Theme, typography, background, layout, shape, motion and accent back to their defaults. Workspaces and agents are untouched."
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
