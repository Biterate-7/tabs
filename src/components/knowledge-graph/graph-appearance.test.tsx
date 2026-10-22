import { afterEach, describe, expect, it } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { setGraphAppearance } from "@/hooks/use-graph-appearance"
import { DEFAULT_GRAPH_APPEARANCE, GRAPH_APPEARANCE_KEY, loadGraphAppearance } from "@/lib/knowledge-graph/appearance"
import { GraphAppearanceControl } from "./graph-appearance"

afterEach(() => setGraphAppearance(DEFAULT_GRAPH_APPEARANCE))

async function openPanel(reducedMotion = false) {
  const user = userEvent.setup()
  render(<GraphAppearanceControl reducedMotion={reducedMotion} />)
  await user.click(screen.getByRole("button", { name: "Graph appearance" }))
  return { user, panel: await screen.findByRole("dialog", { name: "Graph appearance" }) }
}

describe("GraphAppearanceControl", () => {
  it("applies a typed HEX and keeps it", async () => {
    const { user, panel } = await openPanel()
    const field = within(panel).getByRole("textbox", { name: "Accent HEX" })
    await user.clear(field)
    await user.type(field, "#8b5cf6")
    expect(loadGraphAppearance().colors.accent).toBe("#8B5CF6")
    await user.tab()
    expect(field).toHaveProperty("value", "#8B5CF6")
  })

  it("takes a short HEX when the field is left, and refuses what is not a colour", async () => {
    const { user, panel } = await openPanel()
    const connections = within(panel).getByRole("textbox", { name: "Connections HEX" })
    await user.clear(connections)
    await user.type(connections, "0ef{Enter}")
    expect(loadGraphAppearance().colors.connections).toBe("#00EEFF")

    const nodes = within(panel).getByRole("textbox", { name: "Nodes HEX" })
    await user.clear(nodes)
    await user.type(nodes, "#zz12")
    expect(nodes.getAttribute("aria-invalid")).toBe("true")
    await user.tab()
    expect(loadGraphAppearance().colors.nodes).toBeNull()
    expect(nodes.getAttribute("aria-invalid")).toBeNull()
  })

  it("sets every colour from a palette, and resets to Hubble's own in one click", async () => {
    const { user, panel } = await openPanel()
    const reset = within(panel).getByRole("button", { name: "Reset" })
    expect(reset).toHaveProperty("disabled", true)

    await user.click(within(panel).getByRole("button", { name: "Nebula" }))
    expect(loadGraphAppearance().colors).toEqual({ accent: "#C4A1FF", connections: "#8B5CF6", nodes: "#EDE7FF", glow: "#7C3AED", background: "#07050D" })
    expect(within(panel).getByRole("button", { name: "Nebula" }).getAttribute("aria-pressed")).toBe("true")
    expect(within(panel).getByRole("textbox", { name: "Background HEX" })).toHaveProperty("value", "#07050D")

    await user.click(within(panel).getByRole("switch", { name: "Labels" }))
    expect(loadGraphAppearance().labels).toBe(false)

    await user.click(reset)
    expect(loadGraphAppearance()).toEqual(DEFAULT_GRAPH_APPEARANCE)
    expect(window.localStorage.getItem(GRAPH_APPEARANCE_KEY)).toBeNull()
    expect(within(panel).getByRole("button", { name: "Hubble" }).getAttribute("aria-pressed")).toBe("true")
  })

  it("toggles the effects", async () => {
    const { user, panel } = await openPanel()
    await user.click(within(panel).getByRole("switch", { name: "Animation" }))
    await user.click(within(panel).getByRole("switch", { name: "Stars and nebula" }))
    await user.click(within(panel).getByRole("radio", { name: "Large" }))
    expect(loadGraphAppearance()).toMatchObject({ animation: false, effects: false, nodeSize: "large" })
  })

  it("shows animation off, and fixed, while motion is reduced", async () => {
    const { panel } = await openPanel(true)
    const toggle = within(panel).getByRole("switch", { name: "Animation" })
    expect(toggle.getAttribute("aria-checked")).toBe("false")
    expect(toggle.hasAttribute("disabled") || toggle.getAttribute("aria-disabled") === "true" || toggle.hasAttribute("data-disabled")).toBe(true)
  })
})
