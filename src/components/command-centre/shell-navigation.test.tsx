import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { AppSidebar } from "@/components/sidebar/app-sidebar"
import type { Workspace } from "@/lib/workspace/types"

/**
 * The command centre's place in the shell.
 *
 * Two things are asserted here and nowhere else: that the rail reaches the new
 * destination and marks it, and that adding an agent surface did not bring
 * back the one the reset deleted.
 */

const workspaces: Workspace[] = [{ id: "w1", name: "General", tabs: [], createdAt: 0, updatedAt: 0 }]

function renderSidebar(overrides: Partial<React.ComponentProps<typeof AppSidebar>> = {}) {
  const onOpenCommandCentre = vi.fn()
  render(
    <AppSidebar
      workspaces={workspaces}
      currentId="w1"
      relationshipCounts={{}}
      collapsed={false}
      onToggleCollapsed={vi.fn()}
      mobileOpen={false}
      onMobileOpenChange={vi.fn()}
      onSwitch={vi.fn()}
      onCreate={vi.fn()}
      onRename={vi.fn()}
      onDelete={vi.fn()}
      onImportFile={vi.fn()}
      onUpdateLogo={vi.fn()}
      onOpenFavorites={vi.fn()}
      onOpenRecents={vi.fn()}
      onOpenHistoryDump={vi.fn()}
      onOpenGraph={vi.fn()}
      onOpenCommandCentre={onOpenCommandCentre}
      onOpenAgentHistory={vi.fn()}
      onOpenSettings={vi.fn()}
      {...overrides}
    />
  )
  return { onOpenCommandCentre }
}

describe("the rail", () => {
  it("offers the command centre under Agents", () => {
    renderSidebar()
    const agents = screen.getByRole("navigation", { name: /agents/i })
    expect(agents.textContent).toContain("Command Centre")
  })

  it("navigates to it", async () => {
    const user = userEvent.setup()
    const { onOpenCommandCentre } = renderSidebar()

    await user.click(screen.getByRole("button", { name: /command centre/i }))
    expect(onOpenCommandCentre).toHaveBeenCalled()
  })

  it("marks it as the current destination when it is on screen", () => {
    renderSidebar({ currentView: "command-centre" })
    // `aria-current` rather than a colour alone: which destination you are on
    // is a navigational fact the rail already states this way.
    expect(
      screen.getByRole("button", { name: /command centre/i }).getAttribute("aria-current")
    ).toBe("page")
  })

  it("does not mark it when another destination is on screen", () => {
    renderSidebar({ currentView: "graph" })
    expect(
      screen.getByRole("button", { name: /command centre/i }).getAttribute("aria-current")
    ).toBeNull()
  })

  it("keeps Agent History reachable beside it", () => {
    renderSidebar()
    // The command centre is a new destination, not a replacement: history
    // exists to reach runs no live surface is still drawing.
    expect(screen.getByRole("button", { name: /agent history/i })).toBeTruthy()
  })
})

/* ------------------------------------------------------------------ *
 * The reset holds
 * ------------------------------------------------------------------ */

const SRC_DIR = path.resolve(__dirname, "../..")
const REPO_ROOT = path.resolve(SRC_DIR, "..")

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) return entry === "node_modules" ? [] : walk(full)
    return /\.tsx?$/.test(entry) ? [full] : []
  })
}

describe("the Agent World stays deleted", () => {
  it("has no world module, component or hook", () => {
    /*
      Phase A removed ~13.8k lines of spatial agent metaphor and retired its
      storage key. Phase G adds an agent surface, which is exactly the change
      most likely to reintroduce one by accident.
    */
    const files = walk(SRC_DIR).map((file) => path.relative(REPO_ROOT, file).replace(/\\/g, "/"))

    for (const forbidden of [
      /src\/lib\/agents\/world\//,
      /agent-world/,
      /agent-character/,
      /use-agent-world/,
    ]) {
      expect(files.filter((file) => forbidden.test(file)), String(forbidden)).toEqual([])
    }
  })

  it("adds no spatial agent metaphor to the command centre", () => {
    const surfaces = walk(path.join(SRC_DIR, "components/command-centre"))
      .filter((file) => !/\.test\.tsx?$/.test(file))
      .map((file) => ({ file, source: readFileSync(file, "utf8") }))

    expect(surfaces.length).toBeGreaterThan(5)

    for (const entry of surfaces) {
      for (const forbidden of [
        /\bisometric\b/i,
        /\broom\b/i,
        /\bbuilding\b/i,
        /\bcamera\b/i,
        /\bavatar\b/i,
        /\bpet\b/i,
      ]) {
        expect(entry.source, `${entry.file} ${forbidden}`).not.toMatch(forbidden)
      }
    }
  })

  it("keeps the relationship graph, which is information and not a world", () => {
    // Graph = relationships between tabs. World = deleted. The context picker
    // offers the former on purpose.
    const picker = readFileSync(
      path.join(SRC_DIR, "components/command-centre/context-picker.tsx"),
      "utf8"
    )
    expect(picker).toContain("Graph")
    expect(picker).toContain("centerTabIds")
  })
})
