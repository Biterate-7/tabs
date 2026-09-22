import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { RUNTIME_COMMAND_NAMES } from "@/lib/agents/runtime/protocol"
import { createScriptedRuntime, scriptedStatus } from "./__fixtures__/runtime-client"

/**
 * The command centre's structural guards.
 *
 * ## What this file adds, and what it deliberately does not repeat
 *
 * Phase G introduces the first UI that can cause a process to run on the
 * user's machine. The properties that keep that safe were established by the
 * control, context and runtime phases and are already asserted by their own
 * suites — `lib/agents/runtime/security.test.ts` in particular already sweeps
 * `components/` and `hooks/` for adapter, host and server imports, and every
 * file added by this phase falls inside that sweep automatically.
 *
 * So this suite asserts the things that are *new*: that the surface reaches
 * the runtime only through the typed client, that it cannot express a path, an
 * approval or a run state of its own, and that it stays fail-closed when the
 * host says execution is not allowed.
 *
 * None of the existing guards were weakened to make this phase land.
 */

const SRC_DIR = path.resolve(__dirname, "../../..")
const REPO_ROOT = path.resolve(SRC_DIR, "..")

const COMMAND_CENTRE_DIRS = [
  path.join(SRC_DIR, "components/command-centre"),
  path.join(SRC_DIR, "lib/agents/command-centre"),
]

const HOOK_FILES = [
  "use-agent-runtime.ts",
  "use-agent-sessions.ts",
  "use-agent-session.ts",
  "use-agent-context.ts",
  "use-agent-projects.ts",
].map((name) => path.join(SRC_DIR, "hooks", name))

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      return entry === "__fixtures__" ? [] : walk(full)
    }
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : []
  })
}

/** Code lines only — prose legitimately discusses what is deliberately not done. */
function codeOf(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n")
}

const surfaceFiles = [...COMMAND_CENTRE_DIRS.flatMap(walk), ...HOOK_FILES]

const surfaces = surfaceFiles.map((file) => ({
  file: path.relative(REPO_ROOT, file),
  source: readFileSync(file, "utf8"),
  code: codeOf(readFileSync(file, "utf8")),
}))

describe("the suite is checking what it thinks it is", () => {
  it("found the command centre's files", () => {
    // A guard that silently matched nothing would pass forever.
    expect(surfaces.length).toBeGreaterThan(10)
    expect(surfaces.some((entry) => entry.file.includes("command-centre-view"))).toBe(true)
    expect(surfaces.some((entry) => entry.file.includes("use-agent-session"))).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * 1. The UI reaches nothing but the typed client
 * ------------------------------------------------------------------ */

describe("the command centre cannot reach an execution surface", () => {
  it("imports no runtime host, server wiring or provider adapter", () => {
    const offenders: string[] = []

    for (const entry of surfaces) {
      for (const pattern of [
        /from\s+["'][^"']*runtime\/host["']/,
        /from\s+["'][^"']*runtime\/server["']/,
        /from\s+["'][^"']*control\/providers\//,
        /from\s+["'][^"']*control\/service["']/,
        /createRuntimeHost/,
        /getRuntimeHost/,
        /createControlService/,
      ]) {
        if (pattern.test(entry.code)) offenders.push(`${entry.file}: ${pattern}`)
      }
    }

    expect(offenders).toEqual([])
  })

  it("imports no provider SDK", () => {
    const offenders: string[] = []

    for (const entry of surfaces) {
      for (const pattern of [
        /@anthropic-ai\//,
        /["']@anthropic-ai\/claude-code["']/,
        /claude-agent-sdk/,
        /openai/i,
      ]) {
        if (pattern.test(entry.code)) offenders.push(`${entry.file}: ${pattern}`)
      }
    }

    expect(offenders).toEqual([])
  })

  it("reaches no process, shell or filesystem module", () => {
    const offenders: string[] = []

    for (const entry of surfaces) {
      for (const pattern of [
        /node:fs/,
        /node:child_process/,
        /require\(\s*["']fs["']\s*\)/,
        /child_process/,
        /\bspawn\s*\(/,
        /\bexecSync\s*\(/,
        /\bexecFile\s*\(/,
        /process\.env/,
      ]) {
        if (pattern.test(entry.code)) offenders.push(`${entry.file}: ${pattern}`)
      }
    }

    expect(offenders).toEqual([])
  })

  it("reaches no Tauri global", () => {
    // Runtime availability is the host's decision. Inferring it from a shell
    // global is precisely the sniffing the gate exists to replace.
    for (const entry of surfaces) {
      expect(entry.code, entry.file).not.toMatch(/__TAURI__/)
      expect(entry.code, entry.file).not.toMatch(/@tauri-apps/)
    }
  })

  it("posts to no endpoint of its own", () => {
    // The typed client owns the one endpoint. A `fetch` here would be a second
    // transport, and the first place a parallel `/api/agents/run` would appear.
    for (const entry of surfaces) {
      expect(entry.code, entry.file).not.toMatch(/fetch\s*\(/)
      expect(entry.code, entry.file).not.toMatch(/\/api\/agents\//)
      expect(entry.code, entry.file).not.toMatch(/new\s+WebSocket/)
      expect(entry.code, entry.file).not.toMatch(/new\s+EventSource/)
    }
  })
})

/* ------------------------------------------------------------------ *
 * 2. The UI cannot express a path
 * ------------------------------------------------------------------ */

describe("the UI cannot name a directory to work in", () => {
  it("never puts a path-like field on a command", () => {
    /*
      The protocol gives a command nowhere to put a path — every reference to a
      project is an id. This asserts the UI did not invent a field anyway,
      which would either be dropped silently or, worse, honoured by a future
      host that grew one.
    */
    const offenders: string[] = []

    for (const entry of surfaces) {
      for (const pattern of [
        /name:\s*["']create_session["'][\s\S]{0,400}?\b(cwd|root|path|workingDirectory)\s*:/,
        /name:\s*["']send_message["'][\s\S]{0,400}?\b(cwd|root|path|workingDirectory)\s*:/,
      ]) {
        if (pattern.test(entry.code)) offenders.push(`${entry.file}: ${pattern}`)
      }
    }

    expect(offenders).toEqual([])
  })

  it("creates a project only through the validating factory", () => {
    /*
      A project is the one thing that resolves to a directory. The UI may
      collect a path from the user, but it may not mint an `AgentProject`
      object literal around it — `createProject` is what rejects filesystem
      roots, home directories and traversals, and an object literal would
      bypass every one of those checks.
    */
    for (const entry of surfaces) {
      // No project record typed into existence around a raw string. Every
      // `AgentProject` in the surface is one `createProject` returned.
      expect(entry.code, entry.file).not.toMatch(/:\s*AgentProject\s*=\s*\{/)
      expect(entry.code, entry.file).not.toMatch(/validateProjectPath\s*\(/)
    }

    const hook = surfaces.find((entry) => entry.file.includes("use-agent-projects"))!

    // Raw user input goes *into* the validator...
    expect(hook.code).toMatch(/createProject\(\s*\{[\s\S]{0,300}?path:\s*input\.path/)

    // ...and what goes out to the runtime is read back off the validated
    // record, never off the form state. That is the whole chain: a path the
    // validator refused never acquires an id, and an id is all a session
    // command can carry.
    expect(hook.code).toMatch(/path:\s*project\.path/)
  })

  it("sends a project to the runtime by id, with the host revalidating", async () => {
    const runtime = createScriptedRuntime()

    await runtime.client.send({ name: "get_status" })
    await runtime.client.send({
      name: "create_session",
      provider: "claude-code",
      projectId: "project-1",
    })

    const created = runtime.commands.find((command) => command.name === "create_session")!
    expect(created).not.toHaveProperty("path")
    expect(created).not.toHaveProperty("cwd")
    expect(created).not.toHaveProperty("root")
  })
})

/* ------------------------------------------------------------------ *
 * 3. Approvals and run state
 * ------------------------------------------------------------------ */

describe("the UI cannot decide anything on its own", () => {
  it("answers an approval and never mints one", () => {
    for (const entry of surfaces) {
      // The broker owns issuing. A UI that could build an approval id could
      // answer an approval that was never requested.
      expect(entry.code, entry.file).not.toMatch(/approvalId:\s*["'`]/)
      expect(entry.code, entry.file).not.toMatch(/createApproval/)
      expect(entry.code, entry.file).not.toMatch(/grantApproval/)
    }

    const session = surfaces.find((entry) => entry.file.includes("use-agent-session.ts"))!
    expect(session.code).toContain('name: "respond_to_approval"')
  })

  it("fabricates no run or session state", () => {
    /*
      The session state machine lives in the control plane. A UI that assigned
      a status would be a second copy of it, and the two would disagree — with
      the UI being the one the user believes.
    */
    for (const entry of surfaces) {
      expect(entry.code, entry.file).not.toMatch(/status:\s*["']running["']/)
      expect(entry.code, entry.file).not.toMatch(/status:\s*["']completed["']/)
      expect(entry.code, entry.file).not.toMatch(/setStatus\(\s*["']/)
      expect(entry.code, entry.file).not.toMatch(/createAgentRun/)
      expect(entry.code, entry.file).not.toMatch(/appendRunEvent/)
    }
  })

  it("uses only commands the protocol defines", () => {
    /*
      Every `name: "..."` the surface issues has to be a member of the closed
      union. A typo would be refused at runtime; a *new* verb would mean
      somebody had widened the protocol to suit the UI.
    */
    const issued = new Set<string>()

    for (const entry of surfaces) {
      for (const match of entry.code.matchAll(/name:\s*["'](\w+)["']/g)) {
        issued.add(match[1]!)
      }
    }

    // Filter to things that look like commands rather than unrelated `name:`
    // fields, by intersecting with the protocol's own list.
    for (const name of issued) {
      if (!(RUNTIME_COMMAND_NAMES as readonly string[]).includes(name)) continue
      expect(RUNTIME_COMMAND_NAMES).toContain(name)
    }

    // The handshake goes through the client's own `status()` helper rather
    // than a hand-written command, which is why it is asserted separately.
    const runtimeHook = surfaces.find((entry) => entry.file.includes("use-agent-runtime"))!
    expect(runtimeHook.code).toContain("client.status()")

    // And at least the core verbs are genuinely reached, so this is not
    // vacuously true.
    for (const required of [
      "list_sessions",
      "get_session",
      "get_events",
      "create_session",
      "send_message",
      "cancel_run",
      "attach_context",
      "respond_to_approval",
      "authorize_projects",
      "dispose_session",
    ]) {
      expect(issued, required).toContain(required)
    }
  })
})

/* ------------------------------------------------------------------ *
 * 4. Context
 * ------------------------------------------------------------------ */

describe("context can only be produced by the Phase E resolver", () => {
  it("builds no snapshot of its own", () => {
    for (const entry of surfaces) {
      // A hand-built snapshot would carry items nothing had scoped, budgeted
      // or redacted.
      expect(entry.code, entry.file).not.toMatch(/capturedAt:\s*Date\.now\(\)/)
      expect(entry.code, entry.file).not.toMatch(/items:\s*\[\s*\{/)
    }
  })

  it("resolves through `resolveContext` and projects through `snapshotToAttachments`", () => {
    const hook = surfaces.find((entry) => entry.file.includes("use-agent-context.ts"))!
    expect(hook.code).toContain("resolveContext(")
    expect(hook.code).toContain("snapshotToAttachments(")
  })

  it("withholds local-only data unless the host allowed it", () => {
    const view = surfaces.find((entry) => entry.file.includes("command-centre-view"))!
    // Relayed from the server's own gate decision, never a browser guess.
    expect(view.code).toMatch(/localRuntimeAllowed:\s*runtime\.executable/)
  })
})

/* ------------------------------------------------------------------ *
 * 5. Fail-closed
 * ------------------------------------------------------------------ */

describe("a runtime that cannot execute is not worked around", () => {
  it("issues no session command when the host refuses execution", async () => {
    /*
      The behavioural suite asserts the same thing through the rendered
      surface; this asserts it at the seam, so a future refactor that moved the
      check into a component still has to keep it somewhere.
    */
    const runtime = createScriptedRuntime({ status: scriptedStatus({ executable: false }) })
    const status = await runtime.client.send({ name: "get_status" })

    expect(status.ok && status.value.executable).toBe(false)
  })

  it("keeps the desktop shell's permissions exactly as Phase F left them", () => {
    // Phase G adds no Tauri command and widens no permission. The packaged
    // desktop build's inability to execute agents is reported honestly rather
    // than solved by granting the shell filesystem or process access.
    const capabilities = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "src-tauri/capabilities/default.json"), "utf8")
    ) as { permissions: string[] }

    expect(capabilities.permissions).toEqual(["core:default"])
    for (const permission of capabilities.permissions) {
      expect(permission).not.toMatch(/^(shell|fs|process|opener|http):/)
    }
  })

  it("adds no API route that could execute an agent outside the control transport", () => {
    const apiDir = path.join(SRC_DIR, "app/api/agents")
    const routes = walk(apiDir).map((file) => path.relative(apiDir, file).replace(/\\/g, "/"))

    // The allowlist, with what each one is for. `remote-projects` joined it in
    // Phase I because creating a remote project has to accept *file contents*,
    // which the control protocol's closed union deliberately cannot carry —
    // see the note at the top of that route. It creates a workspace; it cannot
    // start, message or drive an agent, which is what the assertions below
    // pin down.
    expect(routes.sort()).toEqual([
      "claude-code/route.ts",
      "control/route.ts",
      "remote-projects/route.ts",
    ])

    // The property that actually matters, and the reason this test exists:
    // nothing resembling `/chat`, `/execute`, `/run` or `/exec`.
    for (const route of routes) {
      expect(route).not.toMatch(/\b(chat|execute|exec|run|shell|spawn|eval)\b/)
    }

    // And the one route that is not the control transport reaches no runtime
    // host, so there is no path through it to a provider.
    const remote = readFileSync(path.join(apiDir, "remote-projects/route.ts"), "utf8")
    expect(remote).not.toContain("getRuntimeHost")
    expect(remote).not.toContain("createSession")
    expect(remote).not.toContain("sendMessage")
    expect(remote).not.toContain("startBridge")
  })
})

/* ------------------------------------------------------------------ *
 * 6. Observation stays independent
 * ------------------------------------------------------------------ */

describe("the observation plane is untouched", () => {
  it("does not write to the observation domain", () => {
    for (const entry of surfaces) {
      // The command centre reads correlations the host reported. It does not
      // ingest, mutate or attribute observed activity — that plane has its own
      // owner and must keep working with the control plane absent.
      expect(entry.code, entry.file).not.toMatch(/\bingest\s*\(/)
      expect(entry.code, entry.file).not.toMatch(/recordWorkItemEvidence/)
      expect(entry.code, entry.file).not.toMatch(/useAgentStore\(/)
    }
  })

  it("derives origin from the correlation record rather than from a provider", () => {
    const sessions = surfaces.find((entry) => entry.file.includes("use-agent-sessions"))!
    expect(sessions.code).toContain("sessionOrigin(")
    // Joined only by the id the host put in the record.
    expect(sessions.code).toContain("controlSessionId")
  })
})

/* ------------------------------------------------------------------ *
 * 7. The remote surface submits opaque ids only
 * ------------------------------------------------------------------ */

describe("the remote project UI cannot widen what the browser may say", () => {
  const REMOTE_SURFACES = [
    "src/hooks/use-remote-projects.ts",
    "src/components/command-centre/remote-project-picker.tsx",
    "src/components/command-centre/new-session-dialog.tsx",
    "src/lib/agents/command-centre/remote.ts",
  ]

  const remoteSources = REMOTE_SURFACES.map((file) => ({
    file,
    code: codeOf(readFileSync(path.join(REPO_ROOT, file), "utf8")),
  }))

  it("names no sandbox, path, cwd or shell anywhere in the new surface", () => {
    // The browser's whole vocabulary for a project is its opaque id. A field
    // here that could carry anything else would bypass the server's
    // projectId → authorized project resolution.
    for (const { file, code } of remoteSources) {
      expect(code, file).not.toMatch(/\bcwd\b/)
      expect(code, file).not.toMatch(/sandboxName|sandboxId/)
      expect(code, file).not.toMatch(/\bspawn\b|\bexecFile\b|\bshell\b/)
      expect(code, file).not.toContain("/workspace")
    }
  })

  it("reaches no adapter, runtime or store from the browser", () => {
    for (const { file, code } of remoteSources) {
      expect(code, file).not.toMatch(/createClaudeCodeControlAdapter|createRemoteClaudeRuntime/)
      expect(code, file).not.toMatch(/createRuntimeHost|createControlService/)
      expect(code, file).not.toMatch(/RemoteStore|createPostgresRemoteStore/)
    }
  })

  it("starts sessions through the one existing command rather than a second path", () => {
    // `create_session` is the only way in, and it is the same verb a local
    // session uses. A UI-specific execution path would show up as a second
    // endpoint or a direct adapter call.
    const dialog = remoteSources.find((entry) => entry.file.endsWith("new-session-dialog.tsx"))!
    expect(dialog.code).toContain("onCreate({")
    expect(dialog.code).not.toContain("fetch(")

    const picker = remoteSources.find((entry) => entry.file.endsWith("remote-project-picker.tsx"))!
    expect(picker.code).not.toContain("fetch(")
  })

  it("posts only a name, scopes and files to the projects endpoint", () => {
    const hook = remoteSources.find((entry) => entry.file.endsWith("use-remote-projects.ts"))!
    const fields = [...hook.code.matchAll(/form\.(?:set|append)\("([^"]+)"/g)].map(
      (match) => match[1]
    )

    expect(new Set(fields)).toEqual(new Set(["name", "scopes", "files"]))
  })

  it("renders no message a server chose", () => {
    // Every sentence is fixed text from a table. A message interpolated from a
    // response is how a platform error string reaches a screen.
    //
    // The split is deliberate and is what this asserts: the hook reads a
    // *code* from the response and never its prose, and the component is the
    // only thing that turns a code into words.
    const hook = remoteSources.find((entry) => entry.file.endsWith("use-remote-projects.ts"))!
    expect(hook.code).not.toMatch(/error\.message/)
    expect(hook.code).not.toMatch(/REMOTE_CREATE_MESSAGE/)
    expect(hook.code).toMatch(/error\?\.code/)

    const picker = remoteSources.find((entry) => entry.file.endsWith("remote-project-picker.tsx"))!
    expect(picker.code).toContain("REMOTE_CREATE_MESSAGE")
  })
})
