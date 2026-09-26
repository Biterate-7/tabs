import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { LOCAL_RUNTIME_ENV_VALUE, LOCAL_RUNTIME_ENV_VAR } from "@/lib/agents/control/runtime";
import { LOCAL_ACTOR } from "./host";

let signedIn: { id: string } | null = null;

vi.mock("@/lib/auth/session", () => ({
  getSession: async () =>
    signedIn ? { ok: true, auth: { user: signedIn } } : { ok: false, reason: "no-session" },
}));

const { resolveRequestActor } = await import("./actor");

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const REQUEST = new Request("https://tabdump.test/api/agents/remote-projects");
const OPTED_IN = { [LOCAL_RUNTIME_ENV_VAR]: LOCAL_RUNTIME_ENV_VALUE };

beforeEach(() => {
  signedIn = null;
});

describe("resolveRequestActor", () => {
  it("is the signed-in account whenever there is one, hosted or not", async () => {
    signedIn = { id: "alice" };
    expect(await resolveRequestActor(REQUEST, { VERCEL: "1" })).toEqual({ id: "account:alice" });
    expect(await resolveRequestActor(REQUEST, OPTED_IN)).toEqual({ id: "account:alice" });
  });

  it("refuses an anonymous visitor on a hosted deployment", async () => {
    // The live Production case: every such visitor used to be one shared owner.
    expect(await resolveRequestActor(REQUEST, { VERCEL: "1", VERCEL_ENV: "production" })).toBeNull();
  });

  it("refuses an anonymous visitor even when the opt-in is pasted into a hosted deployment", async () => {
    expect(await resolveRequestActor(REQUEST, { VERCEL: "1", ...OPTED_IN })).toBeNull();
  });

  it("refuses an anonymous visitor on a server that has not opted in", async () => {
    // No platform markers is not proof of somebody's own machine.
    expect(await resolveRequestActor(REQUEST, {})).toBeNull();
  });

  it("is the local actor only on an opted-in machine", async () => {
    expect(await resolveRequestActor(REQUEST, OPTED_IN)).toBe(LOCAL_ACTOR);
  });
});

describe("the routes that create things", () => {
  for (const route of ["provider-connections", "remote-projects"]) {
    it(`${route} resolves its actor through the gated resolver`, () => {
      const source = readFileSync(
        path.join(REPO_ROOT, "src/app/api/agents", route, "route.ts"),
        "utf8"
      );
      expect(source).toContain("resolveRequestActor(request, process.env)");
      expect(source).toContain('refuse("sign-in-required", 401)');
      // The ungated fallback must not come back through a local helper.
      expect(source).not.toContain("LOCAL_ACTOR");
    });
  }
});
