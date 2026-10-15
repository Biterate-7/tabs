import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { recordActivity, toActivityView, userActivity, activityRecord } from "./activity";
import { CREDENTIAL_TTL_MS, mintCredential, mintRecordId } from "./credentials";
import { cleanLabel, MAX_ACTIVE_CONNECTIONS, MAX_GRANTED_WORKSPACES, mcpResourceFor } from "./oauth";
import { applyProposal, decideProposal, expireIfDue, proposalView } from "./proposals";
import { CLIENT_NAME, isIntegrationClient, isPermissionLevel, levelOf, scopesFor } from "./scopes";
import type { ActivityView } from "./activity";
import type { ConnectionRecord, CredentialRecord } from "./records";
import type { IntegrationClient, PermissionLevel } from "./scopes";
import type { IntegrationStore } from "./store";
import type { ProposalDeps } from "./proposals";

/**
 * What Hubble's own AI Integrations pane asks of the integration layer, on
 * behalf of a signed-in person (src/app/api/integrations/*).
 *
 * Every function takes the user id its route resolved from the session
 * cookie and folds it into each lookup; nothing here takes a user id from a
 * request body. This is also the only place a connection is approved,
 * declined, applied from, narrowed or revoked by the person — none of it is
 * reachable through MCP.
 */

/* ------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------ */

/**
 * A connection's state, from what has actually happened — never from a
 * button having been pressed.
 *
 *   waiting_for_client  authorized (or a token issued) but the client has
 *                       not called Hubble yet: setup is incomplete
 *   connected           the client has called Hubble with this grant
 *   expired             every credential under it has expired; the client
 *                       must sign in (or be given a token) again
 *   revoked             the person disconnected it
 */
export type ConnectionStatus = "waiting_for_client" | "connected" | "expired" | "revoked";

export const CONNECTION_STATUS_LABEL: Record<ConnectionStatus, string> = {
  waiting_for_client: "Setup incomplete — waiting for the AI client",
  connected: "Connected",
  expired: "Authentication expired",
  revoked: "Disconnected",
};

export type ConnectionView = {
  id: string;
  client: IntegrationClient;
  clientName: string;
  label: string;
  method: "oauth" | "token";
  permission: PermissionLevel;
  workspaceIds: string[];
  createdAt: number;
  lastUsedAt?: number;
  status: ConnectionStatus;
  /** Personal tokens only: the last four characters and the expiry, so two can be told apart. */
  token?: { hint: string; expiresAt: number };
};

function isLive(credential: CredentialRecord, now: number): boolean {
  return credential.revokedAt === undefined && credential.expiresAt > now && !(credential.kind === "refresh" && credential.usedAt !== undefined);
}

export function connectionStatus(connection: ConnectionRecord, credentials: readonly CredentialRecord[], now: number): ConnectionStatus {
  if (connection.revokedAt !== undefined) return "revoked";
  const kinds = connection.method === "oauth" ? ["access", "refresh"] : ["personal"];
  const live = credentials.some((credential) => kinds.includes(credential.kind) && isLive(credential, now));
  if (!live) return "expired";
  return connection.lastUsedAt !== undefined ? "connected" : "waiting_for_client";
}

export async function listConnectionViews(store: IntegrationStore, userId: string, now: number): Promise<ConnectionView[]> {
  const connections = (await store.listConnections(userId)).filter((connection) => connection.revokedAt === undefined);
  return Promise.all(
    connections.map(async (connection) => {
      const credentials = await store.listCredentials(userId, connection.id);
      const personal = credentials.find((credential) => credential.kind === "personal" && credential.revokedAt === undefined);
      return {
        id: connection.id,
        client: connection.client,
        clientName: CLIENT_NAME[connection.client],
        label: connection.label,
        method: connection.method,
        permission: levelOf(connection.scopes),
        workspaceIds: connection.workspaceIds,
        createdAt: connection.createdAt,
        ...(connection.lastUsedAt !== undefined ? { lastUsedAt: connection.lastUsedAt } : {}),
        status: connectionStatus(connection, credentials, now),
        ...(personal ? { token: { hint: personal.hint, expiresAt: personal.expiresAt } } : {}),
      };
    })
  );
}

/* ------------------------------------------------------------------ *
 * Token connections (CLIs, config files, the xAI API)
 * ------------------------------------------------------------------ */

export type ConnectionInputProblem = "invalid_client" | "invalid_label" | "invalid_permission" | "no_workspaces" | "unknown_workspace" | "too_many_connections";

export const CONNECTION_PROBLEM_MESSAGES: Record<ConnectionInputProblem, string> = {
  invalid_client: "Choose which AI client this is for.",
  invalid_label: "Give the connection a name of up to 60 characters.",
  invalid_permission: "Choose Read only or Read and save.",
  no_workspaces: "Choose at least one workspace for this connection to see.",
  unknown_workspace: "One of those workspaces is not synced to your account.",
  too_many_connections: `You already have ${MAX_ACTIVE_CONNECTIONS} AI connections. Disconnect one first.`,
};

function readWorkspaces(value: unknown, grantable: ReadonlySet<string>): string[] | ConnectionInputProblem {
  if (!Array.isArray(value) || value.length === 0) return "no_workspaces";
  const ids = [...new Set(value)];
  if (ids.length > MAX_GRANTED_WORKSPACES || !ids.every((id) => typeof id === "string" && grantable.has(id))) return "unknown_workspace";
  return ids as string[];
}

export async function createTokenConnection(
  store: IntegrationStore,
  input: { userId: string; client: unknown; label: unknown; permission: unknown; workspaceIds: unknown; grantable: ReadonlySet<string>; now: number }
): Promise<{ ok: true; token: string; connection: ConnectionView } | { ok: false; problem: ConnectionInputProblem }> {
  if (!isIntegrationClient(input.client)) return { ok: false, problem: "invalid_client" };
  const label = cleanLabel(input.label);
  if (!label) return { ok: false, problem: "invalid_label" };
  if (!isPermissionLevel(input.permission)) return { ok: false, problem: "invalid_permission" };
  const workspaceIds = readWorkspaces(input.workspaceIds, input.grantable);
  if (typeof workspaceIds === "string") return { ok: false, problem: workspaceIds };

  const connection: ConnectionRecord = {
    id: mintRecordId("conn"),
    userId: input.userId,
    client: input.client,
    label,
    method: "token",
    scopes: scopesFor(input.permission),
    workspaceIds,
    createdAt: input.now,
    updatedAt: input.now,
  };
  if (!(await store.createConnection(connection, MAX_ACTIVE_CONNECTIONS))) return { ok: false, problem: "too_many_connections" };
  const minted = mintCredential("personal");
  await store.createCredential({
    id: mintRecordId("cred"),
    connectionId: connection.id,
    kind: "personal",
    tokenHash: minted.tokenHash,
    hint: minted.hint,
    createdAt: input.now,
    expiresAt: input.now + CREDENTIAL_TTL_MS.personal,
  });
  await recordActivity(store, userActivity(input.userId, { kind: "connection", operation: "connection_created", outcome: "ok", connectionId: connection.id, detail: `Created a token connection for ${CLIENT_NAME[connection.client]}` }, input.now));
  return {
    ok: true,
    // The only time the token exists outside the person's own hands.
    token: minted.token,
    connection: {
      id: connection.id,
      client: connection.client,
      clientName: CLIENT_NAME[connection.client],
      label,
      method: "token",
      permission: input.permission,
      workspaceIds,
      createdAt: input.now,
      status: "waiting_for_client",
      token: { hint: minted.hint, expiresAt: input.now + CREDENTIAL_TTL_MS.personal },
    },
  };
}

export async function updateConnection(
  store: IntegrationStore,
  input: { userId: string; connectionId: string; permission?: unknown; workspaceIds?: unknown; grantable: ReadonlySet<string>; now: number }
): Promise<{ ok: true } | { ok: false; problem: ConnectionInputProblem | "not_found" }> {
  const patch: { scopes?: ReturnType<typeof scopesFor>; workspaceIds?: string[] } = {};
  if (input.permission !== undefined) {
    if (!isPermissionLevel(input.permission)) return { ok: false, problem: "invalid_permission" };
    patch.scopes = scopesFor(input.permission);
  }
  if (input.workspaceIds !== undefined) {
    const ids = readWorkspaces(input.workspaceIds, input.grantable);
    if (typeof ids === "string") return { ok: false, problem: ids };
    patch.workspaceIds = ids;
  }
  const updated = await store.updateConnection(input.userId, input.connectionId, patch, input.now);
  if (!updated) return { ok: false, problem: "not_found" };
  await recordActivity(
    store,
    userActivity(input.userId, { kind: "connection", operation: "connection_updated", outcome: "ok", connectionId: input.connectionId, detail: `Changed what ${CLIENT_NAME[updated.client]} may do` }, input.now)
  );
  return { ok: true };
}

export async function revokeConnection(store: IntegrationStore, userId: string, connectionId: string, now: number): Promise<boolean> {
  const revoked = await store.revokeConnection(userId, connectionId, now);
  if (revoked) {
    await recordActivity(store, userActivity(userId, { kind: "connection", operation: "connection_revoked", outcome: "ok", connectionId, detail: "Disconnected an AI client" }, now));
  }
  return revoked;
}

/* ------------------------------------------------------------------ *
 * Proposals and activity
 * ------------------------------------------------------------------ */

export async function listProposalViews(store: IntegrationStore, userId: string, now: number) {
  const rows = await store.listProposals(userId, { limit: 30 });
  const current = await Promise.all(rows.map((row) => expireIfDue(store, row, now)));
  return current.map((proposal) => ({ ...proposalView(proposal), client: proposal.client, clientName: CLIENT_NAME[proposal.client], connectionId: proposal.connectionId }));
}

export async function decideProposalAsUser(deps: ProposalDeps, userId: string, proposalId: string, action: "approve" | "decline" | "apply") {
  const now = deps.now();
  if (action === "apply") {
    const outcome = await applyProposal(deps, userId, proposalId);
    await recordActivity(
      deps.store,
      userActivity(
        userId,
        {
          kind: "apply",
          operation: "apply_organization",
          outcome: outcome.ok ? "ok" : "failed",
          targets: [proposalId],
          ...(outcome.ok ? { detail: `Applied ${outcome.proposal.steps.length} changes from Hubble`, workspaceId: outcome.proposal.workspaceId } : { errorCategory: outcome.reason }),
        },
        now
      )
    );
    return outcome;
  }
  const outcome = await decideProposal(deps.store, userId, proposalId, action, now);
  await recordActivity(
    deps.store,
    userActivity(
      userId,
      {
        kind: action === "approve" ? "approval" : "decline",
        operation: action === "approve" ? "approve_proposal" : "decline_proposal",
        outcome: outcome.ok ? "ok" : "failed",
        targets: [proposalId],
        ...(outcome.ok ? { workspaceId: outcome.proposal.workspaceId, detail: action === "approve" ? "Approved a proposal" : "Declined a proposal" } : { errorCategory: outcome.reason }),
      },
      now
    )
  );
  return outcome;
}

export async function listActivityViews(store: IntegrationStore, userId: string, options: { before?: number; limit: number }): Promise<ActivityView[]> {
  return (await store.listActivity(userId, options)).map(toActivityView);
}

/* ------------------------------------------------------------------ *
 * The connection test
 * ------------------------------------------------------------------ */

export type ConnectionTestStep = { id: "handshake" | "identity" | "listing" | "permissions"; label: string; ok: boolean; detail: string };
export type ConnectionTestResult = { ok: boolean; steps: ConnectionTestStep[]; testedAt: number };

/**
 * A real test of one connection, over the real endpoint.
 *
 * Mints a two-minute `hbtest_` credential under the connection, so the test
 * holds exactly the connection's grant, then speaks MCP to this deployment's
 * own /api/mcp with the official SDK client — over HTTP, through the route,
 * authentication and server the AI client uses:
 *
 *   handshake    initialize completes and tools/list answers
 *   identity     get_connection_info names this account (by its opaque
 *                reference) and this connection's permission
 *   listing      list_workspaces answers, and only with granted workspaces
 *   permissions  write tools are offered exactly when the grant allows
 *                writing; a read-only grant's attempt to write is refused
 *
 * The credential is revoked when the test ends, whatever happened. A
 * successful HTTP response is not the test; each step checks the answer.
 */
export async function testConnection(
  store: IntegrationStore,
  input: {
    userId: string;
    connectionId: string;
    issuer: string;
    fetch: typeof fetch;
    expectedAccountRef: string;
    writeTools: readonly string[];
    now: () => number;
  }
): Promise<ConnectionTestResult | undefined> {
  const connection = await store.getConnection(input.userId, input.connectionId);
  if (!connection || connection.revokedAt !== undefined) return undefined;

  const started = input.now();
  const minted = mintCredential("test");
  const credentialId = mintRecordId("cred");
  await store.createCredential({
    id: credentialId,
    connectionId: connection.id,
    kind: "test",
    tokenHash: minted.tokenHash,
    hint: minted.hint,
    createdAt: started,
    expiresAt: started + CREDENTIAL_TTL_MS.test,
  });

  const steps: ConnectionTestStep[] = [];
  const step = (id: ConnectionTestStep["id"], label: string, ok: boolean, detail: string) => {
    steps.push({ id, label, ok, detail });
    return ok;
  };
  const client = new Client({ name: "hubble-connection-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpResourceFor(input.issuer)), {
    requestInit: { headers: { authorization: `Bearer ${minted.token}` } },
    fetch: input.fetch,
  });

  const text = (result: unknown) => ((result as { content?: { text?: string }[] }).content?.[0]?.text ?? "");
  try {
    let tools: string[] = [];
    try {
      await client.connect(transport);
      tools = (await client.listTools()).tools.map((tool) => tool.name);
      step("handshake", "Hubble's MCP endpoint answers", true, `Connected over MCP; ${tools.length} tools offered.`);
    } catch {
      step("handshake", "Hubble's MCP endpoint answers", false, "The endpoint did not complete the MCP handshake.");
      return { ok: false, steps, testedAt: started };
    }

    try {
      const info = JSON.parse(text(await client.callTool({ name: "get_connection_info", arguments: {} }))) as {
        accountRef?: string;
        connection?: { canSave?: boolean };
        workspaces?: { workspaceId: string }[];
      };
      const level = levelOf(connection.scopes);
      const sameAccount = info.accountRef === input.expectedAccountRef;
      const samePermission = info.connection?.canSave === (level === "write");
      step(
        "identity",
        "Your account is recognised",
        sameAccount && samePermission,
        sameAccount && samePermission ? "Hubble identified your account and this connection's permission." : "The connection answered for a different account or permission."
      );

      const listed = JSON.parse(text(await client.callTool({ name: "list_workspaces", arguments: {} }))) as { workspaces?: { workspaceId: string }[] };
      const ids = (listed.workspaces ?? []).map((w) => w.workspaceId);
      const onlyGranted = ids.every((id) => connection.workspaceIds.includes(id));
      step(
        "listing",
        "Workspaces can be listed",
        Array.isArray(listed.workspaces) && onlyGranted,
        !onlyGranted
          ? "A workspace outside this connection's grant was listed."
          : ids.length === 0
            ? "Listing works, but none of the chosen workspaces is synced to your account yet."
            : `${ids.length} of ${connection.workspaceIds.length} chosen workspaces are visible.`
      );
    } catch {
      step("identity", "Your account is recognised", false, "Hubble could not read this connection's details.");
    }

    const offersWrite = input.writeTools.some((name) => tools.includes(name));
    if (levelOf(connection.scopes) === "write") {
      step("permissions", "Permissions are enforced", offersWrite, offersWrite ? "Read and save: write tools are available." : "Write tools are missing from a Read and save connection.");
    } else {
      let refused = false;
      try {
        const attempt = await client.callTool({ name: "create_collection", arguments: { workspaceId: connection.workspaceIds[0], name: "Connection test" } });
        refused = attempt.isError === true;
      } catch {
        refused = true;
      }
      step(
        "permissions",
        "Permissions are enforced",
        !offersWrite && refused,
        !offersWrite && refused ? "Read only: write tools are not offered, and an attempt to write was refused." : "A read-only connection was able to reach a write tool."
      );
    }
    return { ok: steps.every((entry) => entry.ok), steps, testedAt: started };
  } finally {
    await client.close().catch(() => {});
    await store.revokeCredential(credentialId, input.now()).catch(() => {});
    const ok = steps.length > 0 && steps.every((entry) => entry.ok);
    await recordActivity(
      store,
      activityRecord(
        { userId: input.userId, connectionId: connection.id, client: connection.client, actor: "connection_test" },
        { kind: "connection", operation: "connection_test", outcome: ok ? "ok" : "failed", detail: ok ? "Connection test passed" : "Connection test failed" },
        input.now()
      )
    );
  }
}
