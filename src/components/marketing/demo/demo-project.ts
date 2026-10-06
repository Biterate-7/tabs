import { createGrant } from "@/lib/agents/control/permissions"
import { lineDiff } from "@/lib/agents/project/diff"
import { describeProject } from "@/lib/agents/project/describe"
import type { AgentCapability } from "@/lib/agents/control/capabilities"
import type { ControlProjectChangeInfo } from "@/lib/agents/control/events"
import type { ProjectChangeReview } from "@/lib/agents/project/changes"
import type { ProjectDescriptor } from "@/lib/agents/project/describe"
import type { ProjectInspection } from "@/lib/agents/project/inspection"

/**
 * The landing demo's project (Hubble 1.6): a deterministic adapter in place of
 * a runtime that reaches files. Nothing here touches a filesystem — the demo
 * says so on screen — but every number it shows is computed by the product's
 * own code: the change by `lineDiff` over these two versions of each file, the
 * project as agents are told it by `describeProject`, the review's hunks by
 * the same diff. The demo shows what Hubble would measure, not what it claims.
 */

export const DEMO_PROJECT_ID = "project-hubble"
export const DEMO_PROJECT_NAME = "hubble"

/** The project grant, as the person authorized it: reads, writes and commands, each write and command asking. */
export const DEMO_PROJECT = {
  id: DEMO_PROJECT_ID,
  name: DEMO_PROJECT_NAME,
  source: "local" as const,
  permissions: createGrant(["read_workspace", "read_project", "write_project", "run_commands"], 0, DEMO_PROJECT_ID)!,
}

/** What the runtime would find when it looks: a Next.js app on `main`, with its own checks. */
export const DEMO_PROJECT_INSPECTION: ProjectInspection = {
  projectId: DEMO_PROJECT_ID,
  state: "ready",
  type: "nextjs",
  repository: { kind: "git", branch: "main", head: "4f2a9c1e7b30" },
  checks: [
    { id: "typecheck", command: "npm run typecheck — tsc --noEmit" },
    { id: "test", command: "npm run test — vitest run" },
    { id: "git_status", command: "git status" },
  ],
  files: [],
  inspectedAt: 0,
}

/** The project as an agent is told it — the product's own description. */
export function demoProjectDescriptor(providerCapabilities?: readonly AgentCapability[]): ProjectDescriptor {
  return describeProject({
    project: DEMO_PROJECT,
    inspection: DEMO_PROJECT_INSPECTION,
    local: true,
    ...(providerCapabilities ? { providerCapabilities } : {}),
  })
}

/* ------------------------------------------------------------------ *
 * The two files Codex fixes, before and after
 * ------------------------------------------------------------------ */

const AUTH_BEFORE = `import { NextResponse } from "next/server"
import { verifyPassword } from "@/lib/password"
import { findUser } from "@/lib/users"
import { createSession } from "@/lib/session"

export async function POST(request: Request) {
  const { email, password } = await request.json()
  const user = await findUser(email)
  if (!user) return NextResponse.json({ error: "Invalid credentials" }, { status: 401 })

  const valid = verifyPassword(password, user.passwordHash)
  if (!valid) return NextResponse.json({ error: "Invalid credentials" }, { status: 401 })

  const session = await createSession(user.id)
  const response = NextResponse.json({ ok: true })
  response.cookies.set("session", session.id)
  return response
}
`

const AUTH_AFTER = `import { NextResponse } from "next/server"
import { z } from "zod"
import { verifyPassword } from "@/lib/password"
import { findUser } from "@/lib/users"
import { createSession, SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/session"

const credentials = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

export async function POST(request: Request) {
  const parsed = credentials.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 })

  const { email, password } = parsed.data
  const user = await findUser(email.toLowerCase())
  if (!user) return NextResponse.json({ error: "Invalid credentials" }, { status: 401 })

  // The bug: verifyPassword is async, so an unawaited promise was always truthy.
  const valid = await verifyPassword(password, user.passwordHash)
  if (!valid) return NextResponse.json({ error: "Invalid credentials" }, { status: 401 })

  const session = await createSession(user.id)
  const response = NextResponse.json({ ok: true })
  response.cookies.set(SESSION_COOKIE, session.id, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  })
  return response
}
`

const SESSION_BEFORE = `import { db } from "@/lib/db"

export async function createSession(userId: string) {
  return db.session.create({ data: { userId } })
}

export async function readSession(id: string) {
  return db.session.findUnique({ where: { id } })
}
`

const SESSION_AFTER = `import { randomBytes } from "node:crypto"
import { db } from "@/lib/db"

export const SESSION_COOKIE = "hubble_session"
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7

export async function createSession(userId: string) {
  const id = randomBytes(32).toString("base64url")
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE * 1000)
  return db.session.create({ data: { id, userId, expiresAt } })
}

export async function readSession(id: string) {
  const session = await db.session.findUnique({ where: { id } })
  if (!session || session.expiresAt < new Date()) return null
  return session
}
`

/** A change the demo's agent makes, file by file, before and after. */
export type DemoProjectEdit = { changeId: string; files: readonly { path: string; before: string; after: string }[] }

export const AUTH_FIX_EDIT: Omit<DemoProjectEdit, "changeId"> = {
  files: [
    { path: "src/app/api/auth/route.ts", before: AUTH_BEFORE, after: AUTH_AFTER },
    { path: "src/lib/session.ts", before: SESSION_BEFORE, after: SESSION_AFTER },
  ],
}

/** The change as Hubble measures it: the product's own diff over the two versions. */
export function demoProjectChange(edit: DemoProjectEdit): ControlProjectChangeInfo {
  return {
    changeId: edit.changeId,
    projectId: DEMO_PROJECT_ID,
    outcome: "applied",
    files: edit.files.map((file) => {
      const diff = lineDiff(file.before, file.after)
      return { path: file.path, change: file.before ? "modified" : "created", added: diff.added, removed: diff.removed }
    }),
    undo: "available",
  }
}

/** The review a person opens — the same hunks the runtime would show. */
export function demoProjectReview(edit: DemoProjectEdit): ProjectChangeReview {
  return {
    changeId: edit.changeId,
    files: edit.files.map((file) => {
      const diff = lineDiff(file.before, file.after, { hunks: true })
      return {
        path: file.path,
        change: file.before ? "modified" : "created",
        added: diff.added,
        removed: diff.removed,
        ...(diff.hunks ? { hunks: diff.hunks } : {}),
      }
    }),
  }
}
