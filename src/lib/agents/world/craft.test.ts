import { describe, expect, it } from "vitest";
import { WORLD_CRAFTS, craftForPath, deriveCraft } from "./craft";

/**
 * What the craft derivation is allowed to claim.
 *
 * It picks a desk. It cannot say an agent is busy, cannot change its state
 * and cannot invent an activity — so the tests that matter most here are the
 * ones about *not* concluding anything: the null result, and the refusal to
 * look at anything but the run's own evidence.
 */

describe("deriving a craft from files", () => {
  it("reads code from the files a run touched", () => {
    expect(deriveCraft({ filePaths: ["src/app/page.tsx", "src/lib/utils.ts"] })).toBe("code");
  });

  it("reads writing from prose files", () => {
    expect(deriveCraft({ filePaths: ["docs/phase-18.md", "README.md"] })).toBe("writing");
  });

  it("reads analysis from data files", () => {
    expect(deriveCraft({ filePaths: ["data/usage.csv", "notebooks/churn.ipynb"] })).toBe("analysis");
  });

  it("weighs files above words", () => {
    // A title is a description of the work; a file is a record of it. When
    // the two disagree, the record wins.
    expect(
      deriveCraft({
        title: "Draft the launch announcement",
        filePaths: ["src/a.ts", "src/b.ts", "src/c.ts"],
      })
    ).toBe("code");
  });

  it("stops accumulating after a handful of files of the same kind", () => {
    // Bounded so that two crafts' file evidence stays comparable: a run that
    // touched forty TypeScript files and two spreadsheets is doing code work,
    // and a run that touched five of each is genuinely ambiguous. Without a
    // cap the first run's margin would be twenty to one and the second's
    // would depend on a single stray file.
    const many = Array.from({ length: 40 }, (_, index) => `src/file-${index}.ts`);
    const few = many.slice(0, 4);

    expect(deriveCraft({ filePaths: many })).toBe("code");
    expect(deriveCraft({ filePaths: [...many, "data/a.csv", "data/b.csv"] })).toBe("code");
    expect(deriveCraft({ filePaths: many })).toBe(deriveCraft({ filePaths: few }));
  });

  it("lets words outweigh a single file, and not a pile of them", () => {
    // One touched file is weak evidence about the kind of work; a title and a
    // task title agreeing with each other is stronger. Four files are not.
    expect(
      deriveCraft({
        filePaths: ["src/a.ts"],
        title: "Analyse the dataset",
        workItemTitles: ["Audit the query metrics"],
      })
    ).toBe("analysis");

    expect(
      deriveCraft({
        filePaths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
        title: "Analyse the dataset",
        workItemTitles: ["Audit the query metrics"],
      })
    ).toBe("code");
  });

  it("ignores a file whose extension means nothing", () => {
    expect(deriveCraft({ filePaths: ["LICENSE", "assets/logo.png"] })).toBeNull();
  });

  it("classifies a path by its own basename, whatever separators it used", () => {
    expect(craftForPath("src\\app\\page.tsx")).toBe("code");
    expect(craftForPath("src/app/page.tsx")).toBe("code");
    expect(craftForPath("Dockerfile")).toBe("code");
    expect(craftForPath("notes.md")).toBe("writing");
    expect(craftForPath("")).toBeNull();
  });
});

describe("deriving a craft from words", () => {
  it("reads research from a run that says it is looking something up", () => {
    expect(deriveCraft({ title: "Research competitor pricing" })).toBe("research");
  });

  it("reads code from a task title", () => {
    expect(deriveCraft({ workItemTitles: ["Fix the auth redirect"] })).toBe("code");
  });

  it("weighs a title above the activity line", () => {
    // The activity line is rewritten every few seconds. A figure that changed
    // rooms every time its caption did would be unwatchable, so the stabler
    // signal is the stronger one.
    expect(
      deriveCraft({ title: "Draft the changelog", activity: "Investigating the diff" })
    ).toBe("writing");
  });

  it("counts a phrase once per field, however often it appears", () => {
    expect(deriveCraft({ title: "fix the fix that fixed the fix" })).toBe("code");
    // One code hit at title weight against one research hit at title weight
    // plus one at activity weight.
    expect(
      deriveCraft({ title: "fix fix fix", activity: "Research", workItemTitles: ["Research"] })
    ).toBe("research");
  });
});

describe("declining to guess", () => {
  it("returns null for a run that has said nothing and touched nothing", () => {
    // The state a run is in for its first seconds, and a real answer rather
    // than a gap to be filled: the layout engine puts it on the general floor.
    expect(deriveCraft({})).toBeNull();
    expect(deriveCraft({ title: "", activity: "   ", workItemTitles: [], filePaths: [] })).toBeNull();
  });

  it("returns null for text that matches nothing", () => {
    expect(deriveCraft({ title: "Session 4", activity: "Working" })).toBeNull();
  });
});

describe("being deterministic", () => {
  it("breaks a tie the same way every time", () => {
    // Two crafts on equal evidence must resolve by a stated order rather than
    // by whichever key was iterated first — a figure that changed rooms on a
    // rerender would be the one thing in the world that moved for no reason.
    const tied = { title: "Research", activity: "", workItemTitles: ["Fix"] };
    const first = deriveCraft(tied);
    for (let attempt = 0; attempt < 5; attempt += 1) expect(deriveCraft(tied)).toBe(first);
    expect(WORLD_CRAFTS.indexOf(first!)).toBe(0);
  });

  it("gives the same answer for the same evidence in any order", () => {
    expect(deriveCraft({ filePaths: ["a.md", "b.ts", "c.ts"] })).toBe(
      deriveCraft({ filePaths: ["c.ts", "b.ts", "a.md"] })
    );
  });
});

describe("staying provider-neutral", () => {
  it("has no way to be told who the agent is", () => {
    // The evidence type is the whole contract. A world that sent one provider
    // to the same room every time would be asserting a specialisation the
    // product does not observe.
    const evidence = { title: "Fix the build", activity: "", workItemTitles: [], filePaths: [] };
    expect(Object.keys(evidence).includes("provider")).toBe(false);
    expect(deriveCraft({ ...evidence, ...({ provider: "anything" } as object) })).toBe("code");
  });
});
