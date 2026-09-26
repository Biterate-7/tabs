"use client"

import { createContext, useContext } from "react"
import type { Command } from "./types"

/**
 * The shell-level command palette, as seen by the views inside it.
 *
 * Hubble has one palette and it belongs to the shell, so ⌘K works on every
 * destination — Command Centre, Settings, Graph — not only on the workspace.
 * A view that has commands of its own (the workspace's selection, sort and
 * section actions) contributes them while it is mounted; the shell merges
 * them with its global ones at the moment the palette opens.
 *
 * Contribution is by ref, not by state: a view rebuilds its command list on
 * every render (the callbacks close over current state), and pushing that
 * into shell state would re-render the shell on every keystroke in the view.
 * The palette reads the latest list when it renders, which is exactly when
 * the list has to be current.
 */
export type CommandPaletteHost = {
  /** Opens the palette. */
  open: () => void
  /** Replaces this source's contributed commands; `null` withdraws them. */
  contribute: (source: string, commands: Command[] | null) => void
}

export const CommandPaletteHostContext = createContext<CommandPaletteHost | null>(null)

/**
 * The shell's palette, or `null` when a view is rendered on its own (tests,
 * or any surface mounted outside AppShell) — in which case the view keeps
 * its own palette, exactly as before the palette moved up.
 */
export function useCommandPaletteHost(): CommandPaletteHost | null {
  return useContext(CommandPaletteHostContext)
}
