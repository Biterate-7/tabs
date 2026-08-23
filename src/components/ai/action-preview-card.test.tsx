import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActionPreviewCard } from "./action-preview-card";
import type { PendingActionPreview } from "@/lib/ai/types";

function makePreview(over: Partial<PendingActionPreview> = {}): PendingActionPreview {
  return {
    status: "awaiting",
    summary: "This will move 7 tabs.",
    plan: [{ name: "move_tabs", args: {}, label: 'Move 7 tabs → "Physics IA"', affected: 7 }],
    ...over,
  };
}

describe("ActionPreviewCard", () => {
  it("renders a single proposed action and the summary", () => {
    render(<ActionPreviewCard preview={makePreview()} onApply={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('Move 7 tabs → "Physics IA"')).toBeTruthy();
    expect(screen.getByText("This will move 7 tabs.")).toBeTruthy();
  });

  it("renders a long list of proposed actions", () => {
    const plan = Array.from({ length: 12 }, (_, i) => ({
      name: "create_group",
      args: {},
      label: `Create group → "Group ${i}"`,
      affected: 1,
    }));
    render(<ActionPreviewCard preview={makePreview({ plan, summary: "This will create 12 groups." })} onApply={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('Create group → "Group 0"')).toBeTruthy();
    // Item 11 is beyond COLLAPSE_AFTER — collapsed behind "Show N more" until expanded (see the collapsing test below).
    expect(screen.queryByText('Create group → "Group 11"')).toBeNull();
  });

  it("collapses a plan longer than 8 actions behind a 'Show N more' toggle, expandable on click", async () => {
    const plan = Array.from({ length: 12 }, (_, i) => ({
      name: "create_group",
      args: {},
      label: `Create group → "Group ${i}"`,
      affected: 1,
    }));
    const user = userEvent.setup();
    render(<ActionPreviewCard preview={makePreview({ plan, summary: "This will create 12 groups." })} onApply={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByText("Show 4 more")).toBeTruthy();
    expect(screen.queryByText('Create group → "Group 11"')).toBeNull();

    await user.click(screen.getByText("Show 4 more"));
    expect(screen.getByText('Create group → "Group 11"')).toBeTruthy();
    expect(screen.queryByText("Show 4 more")).toBeNull();
  });

  it("never shows a 'Show N more' toggle for a short plan", () => {
    render(<ActionPreviewCard preview={makePreview()} onApply={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByText(/Show \d+ more/)).toBeNull();
  });

  it("wraps a long workspace name rather than clipping it", () => {
    const longLabel = 'Move 3 tabs → "A Very Long Workspace Name That Should Wrap Instead Of Overflowing The Card"';
    render(
      <ActionPreviewCard
        preview={makePreview({ plan: [{ name: "move_tabs", args: {}, label: longLabel, affected: 3 }] })}
        onApply={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    const item = screen.getByText(longLabel);
    expect(item.className).toContain("break-words");
  });

  it("calls onApply and onCancel when their buttons are clicked", async () => {
    const onApply = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<ActionPreviewCard preview={makePreview()} onApply={onApply} onCancel={onCancel} />);

    await user.click(screen.getByRole("button", { name: /apply changes/i }));
    expect(onApply).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("disables both buttons while applying", () => {
    render(<ActionPreviewCard preview={makePreview({ status: "applying" })} onApply={vi.fn()} onCancel={vi.fn()} />);
    expect((screen.getByRole("button", { name: /apply changes/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /^cancel$/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("hides both buttons once resolved (applied, cancelled, or failed)", () => {
    for (const status of ["applied", "cancelled", "failed"] as const) {
      const { unmount } = render(<ActionPreviewCard preview={makePreview({ status })} onApply={vi.fn()} onCancel={vi.fn()} />);
      expect(screen.queryByRole("button", { name: /apply changes/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /^cancel$/i })).toBeNull();
      unmount();
    }
  });
});
