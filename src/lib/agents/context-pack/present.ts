import { CONTEXT_SCOPE_LABEL } from "@/lib/agents/command-centre/working-context";
import type { ContextPack } from "./pack";

/**
 * A Context Pack in words — the one formatter every surface uses: the
 * Command Centre's context inspector and chip, the handoff dialog, the
 * action inspector's provenance, and the landing page's demo.
 *
 * Names and counts only. Never an id, never an empty placeholder: a section
 * with nothing in it says "None", and a value that would be blank is left out.
 */

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * One line, for a chip or a preview row:
 *
 *     Whole workspace · 12 tabs · 3 collections
 *     Custom · Pricing Research · 5 tabs · 2 files
 *     Collection · Pricing Research
 */
export function contextPackLine(pack: ContextPack): string {
  const parts: string[] = [CONTEXT_SCOPE_LABEL[pack.scope]];
  if (pack.scope === "workspace") {
    parts.push(plural(pack.workspace.tabs, "tab", "tabs"), plural(pack.workspace.collections, "collection", "collections"));
  } else {
    if (pack.collections.length === 1) parts.push(pack.collections[0]!.name);
    else if (pack.collections.length > 1) parts.push(plural(pack.collections.length, "collection", "collections"));
    if (pack.tabs.length === 1 && pack.collections.length === 0) parts.push(pack.tabs[0]!.title);
    else if (pack.tabs.length > 0) parts.push(plural(pack.tabs.length, "tab", "tabs"));
  }
  if (pack.files.length > 0) parts.push(plural(pack.files.length, "file", "files"));
  return parts.join(" · ");
}

export type ContextPackRowKey =
  | "workspace"
  | "focus"
  | "scope"
  | "collections"
  | "tabs"
  | "files"
  | "recentChanges"
  | "previousResult"
  | "instruction";

export type ContextPackRow = {
  key: ContextPackRowKey;
  label: string;
  value: string;
  /** A second line, quieter: the workspace's description. */
  detail?: string;
  /** The names behind a count, for a list under the row. */
  items?: readonly string[];
  /** True when the section holds nothing. Shown, quietly, so "nothing" is a stated fact. */
  empty?: boolean;
};

const RESULT_OUTCOME: Record<NonNullable<ContextPack["previousResult"]>["outcome"], string> = {
  finished: "Finished",
  stopped: "Stopped before finishing",
  failed: "Stopped on an error",
  waiting: "Waiting on you",
  idle: "Not started",
};

/** The inspector's rows, in reading order. */
export function contextPackRows(pack: ContextPack): ContextPackRow[] {
  const rows: ContextPackRow[] = [
    {
      key: "workspace",
      label: "Workspace",
      value: pack.workspace.name,
      ...(pack.workspace.description ? { detail: pack.workspace.description } : {}),
    },
  ];
  if (pack.workspace.focus) rows.push({ key: "focus", label: "Focus", value: pack.workspace.focus });
  rows.push({ key: "scope", label: "Context", value: CONTEXT_SCOPE_LABEL[pack.scope] });

  const whole = pack.scope === "workspace";
  if (whole) {
    rows.push(
      pack.workspace.collections > 0
        ? { key: "collections", label: "Collections", value: `All ${pack.workspace.collections} · read on request` }
        : { key: "collections", label: "Collections", value: "None", empty: true }
    );
    rows.push(
      pack.workspace.tabs > 0
        ? { key: "tabs", label: "Tabs", value: `All ${pack.workspace.tabs} · read on request` }
        : { key: "tabs", label: "Tabs", value: "None", empty: true }
    );
  } else {
    rows.push(
      pack.collections.length > 0
        ? {
            key: "collections",
            label: "Collections",
            value: pack.collections.map((collection) => collection.name).join(", "),
            items: pack.collections.map((collection) => `${collection.name} · ${plural(collection.tabs, "tab", "tabs")}`),
          }
        : { key: "collections", label: "Collections", value: "None", empty: true }
    );
    rows.push(
      pack.tabs.length > 0
        ? { key: "tabs", label: "Tabs", value: `${pack.tabs.length} selected`, items: pack.tabs.map((tab) => tab.title) }
        : { key: "tabs", label: "Tabs", value: "None", empty: true }
    );
  }

  rows.push(
    pack.files.length > 0
      ? {
          key: "files",
          label: "Files",
          value: String(pack.files.length),
          items: pack.files.map((file) => `${file.path}${file.change === "created" ? " · created" : " · edited"}`),
        }
      : { key: "files", label: "Files", value: "None", empty: true }
  );
  rows.push(
    pack.recentChanges.length > 0
      ? {
          key: "recentChanges",
          label: "Recent changes",
          value: String(pack.recentChanges.length),
          items: pack.recentChanges.map((change) => change.text),
        }
      : { key: "recentChanges", label: "Recent changes", value: "None", empty: true }
  );
  const result = pack.previousResult;
  rows.push(
    result
      ? {
          key: "previousResult",
          label: "Previous result",
          value: `Available · ${RESULT_OUTCOME[result.outcome]}`,
          ...(result.lines.length > 0
            ? { items: [...result.lines.map((line) => line.title), ...(result.more > 0 ? [`and ${result.more} more`] : [])] }
            : {}),
        }
      : { key: "previousResult", label: "Previous result", value: "None", empty: true }
  );
  if (pack.instruction) rows.push({ key: "instruction", label: "Instruction", value: `“${pack.instruction}”` });
  return rows;
}

/**
 * What was asked for and is not in the pack, in one sentence — or
 * `undefined` when nothing was left out.
 */
export function contextPackOmittedLine(pack: ContextPack): string | undefined {
  const parts: string[] = [];
  if (pack.omitted.missing > 0) {
    parts.push(`${plural(pack.omitted.missing, "selected item is", "selected items are")} no longer in ${pack.workspace.name}`);
  }
  if (pack.omitted.duplicates > 0) parts.push(`${plural(pack.omitted.duplicates, "duplicate tab", "duplicate tabs")} left out`);
  if (pack.omitted.truncated > 0) parts.push(`${pack.omitted.truncated} left out to stay within limits`);
  return parts.length > 0 ? `${parts.join(" · ")}.` : undefined;
}

/**
 * Where a session's context stands, said once:
 *
 *   - `reads`: the whole workspace with nothing attached — read on request.
 *   - `pending`: attached, sent with the next message.
 *   - `delivered`: the agent has this pack.
 *   - `changed`: the agent has an older pack; this one has not been sent.
 *   - `historical`: an ended session — what it had, not what it would get.
 */
export type ContextDeliveryState = "reads" | "pending" | "delivered" | "changed" | "historical";

export function contextDeliveryLine(state: ContextDeliveryState, agentName: string): string {
  switch (state) {
    case "reads":
      return `${agentName} reads this workspace when it needs to`;
    case "pending":
      return "Sent with your next message";
    case "delivered":
      return `${agentName} has this`;
    case "changed":
      return `Changed since ${agentName} received it`;
    case "historical":
      return "As it was when the session ran";
  }
}
