import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UndoActionButton } from "./undo-action-button";
import type { UndoAction } from "@/lib/ai/types";

function makeUndo(over: Partial<UndoAction> = {}): UndoAction {
  return { entryId: "undo-1", status: "available", ...over };
}

describe("UndoActionButton", () => {
  it("renders an enabled Undo button when available", () => {
    render(<UndoActionButton undo={makeUndo()} onUndo={vi.fn()} />);
    const button = screen.getByRole("button", { name: /^undo$/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it("calls onUndo when clicked", async () => {
    const onUndo = vi.fn();
    const user = userEvent.setup();
    render(<UndoActionButton undo={makeUndo()} onUndo={onUndo} />);

    await user.click(screen.getByRole("button", { name: /^undo$/i }));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("disables the button and shows a busy label while undoing", () => {
    render(<UndoActionButton undo={makeUndo({ status: "undoing" })} onUndo={vi.fn()} />);
    const button = screen.getByRole("button", { name: /undoing/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("replaces the button with a static 'Undone' label once undone", () => {
    render(<UndoActionButton undo={makeUndo({ status: "undone" })} onUndo={vi.fn()} />);
    expect(screen.getByText("Undone")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders nothing when unavailable (the explanation is a separate message)", () => {
    const { container } = render(<UndoActionButton undo={makeUndo({ status: "unavailable" })} onUndo={vi.fn()} />);
    expect(container.textContent).toBe("");
  });
});
