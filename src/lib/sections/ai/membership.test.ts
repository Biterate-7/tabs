import { describe, expect, it } from "vitest";
import { partitionClusterMembers, pathNamesPlatform } from "./membership";
import type { JoinReason } from "@/lib/organize/cluster";
import type { Tab } from "@/lib/tabs/types";

function yt(id: string, title: string): Tab {
  return {
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    normalizedUrl: `https://www.youtube.com/watch?v=${id}`,
    domain: "www.youtube.com",
    title,
    category: "other",
  };
}

function site(id: string, domain: string, title: string): Tab {
  return { id, url: `https://${domain}/${id}`, normalizedUrl: `https://${domain}/${id}`, domain, title, category: "other" };
}

function reasons(entries: Record<string, JoinReason>): Map<string, JoinReason> {
  return new Map(Object.entries(entries));
}

const PHYSICS = ["Physics", "Projectile Motion"];

describe("partitionClusterMembers", () => {
  it("keeps same-platform tabs whose titles are about the section's topic", () => {
    const members = [yt("p1", "Projectile Motion Explained"), yt("p2", "Projectile Motion Practice Problems")];
    const { belong, released } = partitionClusterMembers({
      members,
      path: PHYSICS,
      joinReasons: reasons({ p1: "domain", p2: "domain" }),
      semanticKeyByTabId: new Map(),
    });
    expect(belong.map((t) => t.id)).toEqual(["p1", "p2"]);
    expect(released).toEqual([]);
  });

  it("releases same-platform tabs about something else entirely", () => {
    const members = [
      yt("p1", "Projectile Motion Explained"),
      yt("p2", "Projectile Motion Practice Problems"),
      yt("c1", "Organic Chemistry Basics"),
      yt("e1", "Economics: Inflation Explained"),
      yt("g1", "Insane Gaming Highlights Montage"),
    ];
    const { belong, released } = partitionClusterMembers({
      members,
      path: PHYSICS,
      joinReasons: reasons({ p1: "domain", p2: "domain", c1: "domain", e1: "domain", g1: "domain" }),
      semanticKeyByTabId: new Map(),
    });
    expect(belong.map((t) => t.id)).toEqual(["p1", "p2"]);
    expect(released.map((t) => t.id)).toEqual(["c1", "e1", "g1"]);
  });

  it("keeps a topical member from any platform", () => {
    const members = [
      yt("p1", "Projectile Motion Explained"),
      site("w1", "en.wikipedia.org", "Projectile motion"),
      site("k1", "khanacademy.org", "Projectile motion review"),
      yt("g1", "Insane Gaming Highlights Montage"),
    ];
    const { belong, released } = partitionClusterMembers({
      members,
      path: PHYSICS,
      joinReasons: reasons({ p1: "domain", w1: "keyword", k1: "keyword", g1: "domain" }),
      semanticKeyByTabId: new Map(),
    });
    expect(belong.map((t) => t.id)).toEqual(["p1", "w1", "k1"]);
    expect(released.map((t) => t.id)).toEqual(["g1"]);
  });

  it("keeps a member whose own title shares no words with the section name, on the embedding's word", () => {
    // The false-negative the domain check would otherwise cause: a genuinely
    // relevant video whose title happens not to repeat the section's name.
    // Its embedding cluster is shared with a validated member, which is the
    // signal saying "same topic", not "same website".
    const members = [
      yt("p1", "Projectile Motion Explained"),
      yt("h1", "Horizontal Launch Equations Walkthrough"),
      yt("g1", "Insane Gaming Highlights Montage"),
    ];
    const { belong, released } = partitionClusterMembers({
      members,
      path: PHYSICS,
      joinReasons: reasons({ p1: "domain", h1: "domain", g1: "domain" }),
      semanticKeyByTabId: new Map([
        ["p1", "sem-0"],
        ["h1", "sem-0"],
      ]),
    });
    expect(belong.map((t) => t.id)).toEqual(["p1", "h1"]);
    expect(released.map((t) => t.id)).toEqual(["g1"]);
  });

  it("never chains membership through a member it just admitted", () => {
    // A -> B on topic, B -> C on a shared embedding cluster would be fine; the
    // case guarded here is C riding in on a key shared only with a tab that
    // itself got in on a key. `g1` shares sem-9 with `x1`, and `x1` shares
    // nothing with the validated core, so neither belongs.
    const members = [yt("p1", "Projectile Motion Explained"), yt("x1", "Cooking Pasta"), yt("g1", "Gaming Montage")];
    const { released } = partitionClusterMembers({
      members,
      path: PHYSICS,
      joinReasons: reasons({ p1: "domain", x1: "domain", g1: "domain" }),
      semanticKeyByTabId: new Map([
        ["x1", "sem-9"],
        ["g1", "sem-9"],
      ]),
    });
    expect(released.map((t) => t.id)).toEqual(["x1", "g1"]);
  });

  it("keeps a member that joined on a content signal without asking it to justify itself", () => {
    // `semantic`/`keyword` members already have evidence of their own — only
    // the ones in the cluster purely because of the shared site are checked.
    const members = [yt("p1", "Projectile Motion Explained"), yt("q1", "Kinematics In Two Dimensions")];
    const { belong } = partitionClusterMembers({
      members,
      path: PHYSICS,
      joinReasons: reasons({ p1: "domain", q1: "semantic" }),
      semanticKeyByTabId: new Map(),
    });
    expect(belong.map((t) => t.id)).toEqual(["p1", "q1"]);
  });

  it("keeps every member when the section names the platform itself", () => {
    // The behaviour that must NOT regress: a real website cluster still
    // becomes that website's section, whatever the individual pages are about.
    const members = [
      site("i1", "www.instagram.com", "Instagram"),
      site("i2", "m.instagram.com", "Login • Instagram"),
      site("i3", "instagram.com", "Reels • Instagram"),
    ];
    const { belong, released } = partitionClusterMembers({
      members,
      path: ["Social", "Instagram"],
      joinReasons: reasons({ i1: "domain", i2: "domain", i3: "domain" }),
      semanticKeyByTabId: new Map(),
    });
    expect(belong).toHaveLength(3);
    expect(released).toEqual([]);
  });

  it("leaves a single root category alone — it is broad by design", () => {
    const members = [yt("p1", "Projectile Motion Explained"), yt("g1", "Gaming Montage")];
    const { belong, released } = partitionClusterMembers({
      members,
      path: ["Physics"],
      joinReasons: reasons({ p1: "domain", g1: "domain" }),
      semanticKeyByTabId: new Map(),
    });
    expect(belong).toHaveLength(2);
    expect(released).toEqual([]);
  });

  it("keeps the whole cluster when the path describes none of it", () => {
    // Releasing everyone would be a claim about the cluster; what this
    // actually says is that the PATH is wrong, which is not this function's
    // to decide.
    const members = [yt("a1", "Gaming Montage"), yt("b1", "Cooking Pasta")];
    const { belong, released } = partitionClusterMembers({
      members,
      path: PHYSICS,
      joinReasons: reasons({ a1: "domain", b1: "domain" }),
      semanticKeyByTabId: new Map(),
    });
    expect(belong).toHaveLength(2);
    expect(released).toEqual([]);
  });

  it("preserves member order, which naming and the deterministic path both read", () => {
    const members = [
      yt("g1", "Gaming Montage"),
      yt("p1", "Projectile Motion Explained"),
      yt("c1", "Organic Chemistry"),
      yt("p2", "Projectile Motion Practice"),
    ];
    const { belong } = partitionClusterMembers({
      members,
      path: PHYSICS,
      joinReasons: reasons({ g1: "domain", p1: "domain", c1: "domain", p2: "domain" }),
      semanticKeyByTabId: new Map(),
    });
    expect(belong.map((t) => t.id)).toEqual(["p1", "p2"]);
  });
});

describe("pathNamesPlatform", () => {
  it("recognizes a section named after the cluster's own site", () => {
    expect(pathNamesPlatform("YouTube", "youtube.com")).toBe(true);
    expect(pathNamesPlatform("Youtube", "www.youtube.com")).toBe(true);
    expect(pathNamesPlatform("Instagram", "m.instagram.com")).toBe(true);
  });

  it("does not mistake a topic for the platform", () => {
    expect(pathNamesPlatform("Projectile Motion", "youtube.com")).toBe(false);
    expect(pathNamesPlatform("Physics", "youtube.com")).toBe(false);
    expect(pathNamesPlatform("YouTube", undefined)).toBe(false);
  });
});
