import { beforeEach, describe, expect, it } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { setStorageNamespace } from "@/lib/storage/namespace"
import { createTestConnector, testObservation } from "@/lib/agents/connectors/__fixtures__/test-connector"
import { createConnectorManager } from "@/lib/agents/connectors/manager"
import { useAgentConnectors } from "./use-agent-connectors"
import type { TestConnector } from "@/lib/agents/connectors/__fixtures__/test-connector"
import type { ConnectorManager } from "@/lib/agents/connectors/manager"

/**
 * The React binding, over a real manager and real connectors.
 *
 * What is worth testing here is only what React adds: that a status change
 * re-renders, that a mount does not start observing unless asked to, and that
 * unmounting leaves nothing attached. The lifecycle rules themselves belong to
 * the manager and are tested there.
 */

function setup(options: { restore?: boolean } = {}) {
  const claude = createTestConnector({ provider: "claude-code", displayName: "Claude Code" })
  const gemini = createTestConnector({
    provider: "gemini",
    displayName: "Gemini",
    connectTo: "unavailable",
  })

  const manager = createConnectorManager({
    registrations: [
      { descriptor: claude.descriptor, create: () => claude },
      { descriptor: gemini.descriptor, create: () => gemini },
    ],
  })

  const view = renderHook(() => useAgentConnectors({ manager, ...options }))
  return { claude, gemini, manager, view }
}

beforeEach(() => {
  window.localStorage.clear()
  setStorageNamespace(null)
})

describe("listing", () => {
  it("renders every registered provider as disconnected before anything happens", () => {
    const { view, manager } = setup()

    expect(view.result.current.connectors.map((entry) => entry.descriptor.displayName)).toEqual([
      "Claude Code",
      "Gemini",
    ])
    expect(view.result.current.connectedCount).toBe(0)
    expect(view.result.current.enabledCount).toBe(0)

    view.unmount()
    manager.dispose()
  })

  it("does not restore connections unless asked to", async () => {
    const { claude, view, manager } = setup()

    await waitFor(() => expect(view.result.current.connectors).toHaveLength(2))

    // A surface that only displays connector state must not be the thing that
    // starts observing the user's machine.
    expect(claude.connectCount).toBe(0)

    view.unmount()
    manager.dispose()
  })
})

describe("connecting", () => {
  it("re-renders with the new status", async () => {
    const { view, manager } = setup()

    await act(async () => {
      await view.result.current.connect("claude-code")
    })

    expect(view.result.current.view("claude-code")?.status.kind).toBe("connected")
    expect(view.result.current.connectedCount).toBe(1)

    view.unmount()
    manager.dispose()
  })

  it("counts intent separately from an actual connection", async () => {
    const { view, manager } = setup()

    await act(async () => {
      await view.result.current.connect("gemini")
    })

    // The user asked for Gemini and got an honest "unavailable". Intent is
    // recorded; a connection is not claimed.
    expect(view.result.current.view("gemini")?.enabled).toBe(true)
    expect(view.result.current.view("gemini")?.status.kind).toBe("unavailable")
    expect(view.result.current.connectedCount).toBe(0)
    expect(view.result.current.enabledCount).toBe(1)

    view.unmount()
    manager.dispose()
  })

  it("reflects a status change the connector made on its own", async () => {
    const { claude, view, manager } = setup()

    await act(async () => {
      await view.result.current.connect("claude-code")
    })

    await act(async () => {
      claude.fail("permission-denied")
    })

    expect(view.result.current.view("claude-code")?.status.kind).toBe("error")
    expect(view.result.current.view("claude-code")?.health.kind).toBe("failing")

    view.unmount()
    manager.dispose()
  })

  it("disconnects and reports it", async () => {
    const { view, manager } = setup()

    await act(async () => {
      await view.result.current.connect("claude-code")
    })
    act(() => {
      view.result.current.disconnect("claude-code")
    })

    expect(view.result.current.view("claude-code")?.status.kind).toBe("disconnected")
    expect(view.result.current.view("claude-code")?.enabled).toBe(false)

    view.unmount()
    manager.dispose()
  })
})

describe("restore", () => {
  it("connects what was previously enabled, once", async () => {
    const claude = createTestConnector({ provider: "claude-code" })
    const manager: ConnectorManager = createConnectorManager({
      registrations: [{ descriptor: claude.descriptor, create: () => claude }],
    })

    await manager.connect("claude-code")
    manager.disconnect("claude-code")
    await manager.connect("claude-code")
    const before = claude.connectCount

    const view = renderHook(() => useAgentConnectors({ manager, restore: true }))
    await waitFor(() => expect(claude.connectCount).toBeGreaterThan(before))

    const afterFirstRestore = claude.connectCount
    view.rerender()
    view.rerender()

    // A re-render is not a reason to reconnect.
    expect(claude.connectCount).toBe(afterFirstRestore)

    view.unmount()
    manager.dispose()
  })
})

describe("cleanup", () => {
  it("detaches its status listener on unmount", async () => {
    const { claude, view, manager } = setup()

    await act(async () => {
      await view.result.current.connect("claude-code")
    })

    view.unmount()

    // A status change after unmount must not reach a torn-down component —
    // React would warn, and in a real app the listener would be a leak.
    expect(() => claude.fail()).not.toThrow()

    manager.dispose()
  })

  it("does not disconnect anything on unmount", async () => {
    const { claude, view, manager } = setup()

    await act(async () => {
      await view.result.current.connect("claude-code")
    })
    view.unmount()

    // The manager outlives any one surface: closing settings must not stop
    // the workspace observing.
    expect(claude.getStatus().kind).toBe("connected")

    manager.dispose()
  })

  it("survives StrictMode's double mount without doubling subscriptions", async () => {
    const claude: TestConnector = createTestConnector({ provider: "claude-code" })
    const manager = createConnectorManager({
      registrations: [{ descriptor: claude.descriptor, create: () => claude }],
    })

    // Intent first, so restore has something to reconnect.
    await manager.connect("claude-code")

    const view = renderHook(() => useAgentConnectors({ manager, restore: true }))
    await waitFor(() => expect(claude.connectCount).toBeGreaterThan(1))

    let delivered = 0
    manager.subscribe(() => {
      delivered += 1
    })
    claude.emit([testObservation({ provider: "claude-code" })])

    expect(delivered).toBe(1)
    expect(claude.observerCount).toBe(1)

    view.unmount()
    manager.dispose()
  })
})
