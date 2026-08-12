import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppShell } from "./app-shell";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AppShell persistence", () => {
  it("shows the landing page when nothing is persisted", async () => {
    render(<AppShell />);
    expect(await screen.findByPlaceholderText(/Paste your tabs/)).toBeTruthy();
  });

  it("persists a dumped workspace and restores it on remount", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<AppShell />);

    await user.type(
      await screen.findByPlaceholderText(/Paste your tabs/),
      "https://github.com/a"
    );
    await user.click(screen.getByRole("button", { name: /Dump 1 tab/ }));
    expect(await screen.findByText("github.com")).toBeTruthy();

    unmount();
    render(<AppShell />);

    expect(await screen.findByText("github.com")).toBeTruthy();
  });

  it("persists a category reassignment", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<AppShell />);

    await user.type(
      await screen.findByPlaceholderText(/Paste your tabs/),
      "https://github.com/a"
    );
    await user.click(screen.getByRole("button", { name: /Dump 1 tab/ }));

    await user.type(
      await screen.findByPlaceholderText("Search tabs..."),
      "github"
    );
    await user.click(screen.getByRole("button", { name: "Projects" }));
    await user.click(await screen.findByText("School"));

    unmount();
    render(<AppShell />);

    await user.type(
      await screen.findByPlaceholderText("Search tabs..."),
      "github"
    );
    expect(await screen.findByText("School")).toBeTruthy();
  });

  it("Clear also removes the persisted workspace", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<AppShell />);

    await user.type(
      await screen.findByPlaceholderText(/Paste your tabs/),
      "https://github.com/a"
    );
    await user.click(screen.getByRole("button", { name: /Dump 1 tab/ }));
    expect(await screen.findByText("github.com")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Clear" }));
    await user.click(await screen.findByRole("button", { name: "Clear workspace" }));
    expect(await screen.findByPlaceholderText(/Paste your tabs/)).toBeTruthy();

    unmount();
    render(<AppShell />);
    expect(await screen.findByPlaceholderText(/Paste your tabs/)).toBeTruthy();
  });

  it("degrades gracefully when localStorage is unavailable", async () => {
    // Plain reassignment (and vi.spyOn) don't stick on jsdom's Storage
    // object — see the comment in persistence.test.ts. Replacing the whole
    // global is what actually simulates an unavailable localStorage.
    vi.stubGlobal("localStorage", {
      ...window.localStorage,
      setItem: () => {
        throw new Error("unavailable");
      },
    });
    const user = userEvent.setup();
    render(<AppShell />);

    await user.type(
      await screen.findByPlaceholderText(/Paste your tabs/),
      "https://github.com/a"
    );
    await user.click(screen.getByRole("button", { name: /Dump 1 tab/ }));
    expect(await screen.findByText("github.com")).toBeTruthy();
  });
});
