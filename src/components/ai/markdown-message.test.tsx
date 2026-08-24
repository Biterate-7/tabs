import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MarkdownMessage } from "./markdown-message";

describe("MarkdownMessage", () => {
  it("renders headings, bold, inline code, and list items as real elements — not literal Markdown syntax", () => {
    const { container } = render(
      <MarkdownMessage text={"### TabDump Development & Hosting\n\n- **Vercel:** deployment previews\n- GitHub: `Biterate-7/tabs` repository"} />
    );

    expect(screen.getByRole("heading", { name: "TabDump Development & Hosting" })).toBeTruthy();
    expect(screen.getByText("Vercel:").tagName).toBe("STRONG");
    expect(screen.getByText("Biterate-7/tabs").tagName).toBe("CODE");
    expect(container.querySelectorAll("li")).toHaveLength(2);

    // No literal Markdown syntax characters leaked through unrendered.
    expect(container.textContent).not.toContain("###");
    expect(container.textContent).not.toContain("**");
    expect(container.textContent).not.toContain("`");
  });

  it("renders backslash-escaped Markdown (the exact reported bug) as real formatting, not literal escape characters", () => {
    const text = 'Here is a breakdown:\n\n\\#\\#\\# 1. \\*\\*TabDump Development & Hosting\\*\\*\n\nUses the \\`tabdump\\` package.';
    const { container } = render(<MarkdownMessage text={text} />);

    expect(screen.getByRole("heading", { name: "1. TabDump Development & Hosting" })).toBeTruthy();
    expect(screen.getByText("tabdump").tagName).toBe("CODE");
    expect(container.textContent).not.toContain("\\");
    expect(container.textContent).not.toContain("###");
    expect(container.textContent).not.toContain("**");
  });

  it("does not execute raw HTML/script content from the model", () => {
    const { container } = render(<MarkdownMessage text={'<img src=x onerror="window.__pwned = true">'} />);
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders an ordinary paragraph with no Markdown syntax unchanged", () => {
    render(<MarkdownMessage text="You have 1 tab saved: A quick note." />);
    expect(screen.getByText("You have 1 tab saved: A quick note.")).toBeTruthy();
  });
});
