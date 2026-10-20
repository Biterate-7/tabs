// One "Add to Hubble Desktop" run, start to finish:
//
//   collect the tabs → find Hubble Desktop (or open it with hubble://import and wait)
//   → hand the batch over → wait while the person picks a project in Hubble
//   → say how it went, where the person is (a toast in the page, the popup)
//
// Every browser call is injected (`deps`), so the whole flow — desktop open,
// closed, not installed, not responding, cancelled — is tested without Chrome
// or a desktop app (desktop-add.test.js). background.js supplies the real ones.

import {
  DesktopError,
  buildDesktopConversation,
  buildDesktopPayload,
  describeDesktopPhase,
  describeDesktopResult,
  describeDesktopSave,
  describeDesktopSavePhase,
  findDesktop,
  sendToDesktop,
  waitForDesktop,
  waitForDesktopResult,
} from "./desktop.js";
import { isBlankTab } from "./quick-add.js";

/**
 * @param deps.collectTabs   ({ scope, tabIds, windowId }) => Promise<chrome.tabs.Tab[]>
 * @param deps.launch        () => Promise<boolean>   opens hubble://import; false when it couldn't
 * @param deps.show          (toast) => Promise<void> the toast in the page / the popup's state
 * @param deps.markSeen      () => Promise<void>      Hubble Desktop answered at least once
 * @param deps.wasSeen       () => Promise<boolean>
 * @param deps.fetch, deps.sleep, deps.now, deps.log
 * @returns run({ scope, tabIds, windowId }) → the outcome, also what `show` was last given
 */
export function createDesktopAdd(deps) {
  const { collectTabs, launch, show, markSeen, wasSeen, fetch, sleep, now = Date.now, log = () => {} } = deps;
  let running = false;

  async function finish(outcome) {
    const toast = { ...describeDesktopResult(outcome), final: true };
    await show(toast);
    log("desktop-add-finished", { status: outcome.status ?? outcome.reason, added: outcome.added, duplicates: outcome.duplicates, failed: outcome.failed });
    return { ...outcome, toast };
  }

  return async function run({ scope, tabIds, windowId } = {}) {
    if (running) {
      const toast = { ...describeDesktopResult({ reason: "already-running" }), final: true };
      await show(toast);
      return { reason: "already-running", toast };
    }
    running = true;
    try {
      const chromeTabs = await collectTabs({ scope, tabIds, windowId });
      const { payload, skippedRestricted, overLimit } = buildDesktopPayload(chromeTabs);
      const counts = { skippedRestricted, overLimit };
      log("desktop-add-started", { requestId: payload.requestId, scope: tabIds ? "tabs" : scope, tabs: payload.tabs.length, ...counts });
      if (payload.tabs.length === 0) {
        const blankOnly = chromeTabs.length > 0 && chromeTabs.every(isBlankTab);
        return await finish({ reason: "no-importable-tabs", ...counts, ...(blankOnly ? { blankOnly } : {}) });
      }

      await show(describeDesktopPhase("connecting", payload.tabs.length));
      let desktop = await findDesktop({ fetch });
      log("desktop-handshake", { requestId: payload.requestId, found: Boolean(desktop), port: desktop?.port });

      if (!desktop) {
        // Not open (or not installed — Chrome can't tell us which). Open it and give it a moment.
        const seen = await wasSeen();
        await show(describeDesktopPhase("launching", payload.tabs.length));
        const launched = await launch();
        desktop = launched ? await waitForDesktop({ fetch, sleep, now, onTick: () => show(describeDesktopPhase("launching", payload.tabs.length)) }) : undefined;
        log("desktop-launch", { requestId: payload.requestId, launched, found: Boolean(desktop) });
        if (!desktop) return await finish({ reason: seen ? "desktop-not-responding" : "desktop-not-found", ...counts });
      }
      await markSeen();

      const session = await sendToDesktop({ port: desktop.port, payload, fetch });
      log("desktop-sent", { requestId: payload.requestId, accepted: session.accepted, rejected: session.rejected });
      await show(describeDesktopPhase("waiting", payload.tabs.length));
      const result = await waitForDesktopResult({ session, fetch, sleep, now, onTick: () => show(describeDesktopPhase("waiting", payload.tabs.length)) });
      return await finish({ ...result, ...counts });
    } catch (err) {
      const reason = err instanceof DesktopError ? err.reason : "desktop-not-responding";
      log("desktop-add-failed", { reason, detail: err instanceof Error ? err.message : String(err) });
      return await finish({ reason });
    } finally {
      running = false;
    }
  };
}

// One "Save this conversation" into Hubble Desktop:
//
//   Hubble Desktop open (and new enough to take conversations)?
//     no  → { fallback: true }: the caller saves to Hubble on the web, as before
//     yes → hand the conversation over → wait while the person picks a project
//           in Hubble → say how it went, in the AI app's page and to the popup
//
// Unlike adding tabs, this never opens Hubble Desktop: where Save goes follows
// what is open, so a person who only uses Hubble on the web is never sent to
// an app they didn't start.
//
// One save per conversation at a time, not one at all: while conversation A
// waits for its project in Hubble Desktop, A again is refused
// ("already-running") but conversation B goes ahead — Hubble Desktop queues it.

/**
 * @param deps.show   (toast) => Promise<void> the toast in the AI app's page
 * @param deps.fetch, deps.sleep, deps.now, deps.log
 * @returns save({ provider, url, title, turns, truncated, key }, { show }) → the outcome, or { fallback: true, reason }.
 *   `key` names the conversation (conversationIdentityOf in ai-pages.js; the address when absent); `show`, when
 *   given, is where this one save's toasts go instead of `deps.show` — each save reports in its own tab.
 */
export function createDesktopSave(deps) {
  const { fetch, sleep, now = Date.now, log = () => {} } = deps;
  const running = new Set();

  return async function save(capture, options = {}) {
    const show = options.show ?? deps.show;
    const desktop = await findDesktop({ fetch }).catch(() => undefined);
    if (!desktop?.conversations) {
      log("desktop-save-skipped", { found: Boolean(desktop) });
      return { fallback: true, reason: desktop ? "desktop-too-old" : "desktop-not-open" };
    }
    const key = typeof capture?.key === "string" && capture.key ? capture.key : String(capture?.url ?? "");
    if (running.has(key)) return finish(show, { reason: "already-running" });
    running.add(key);
    try {
      const { payload, turns, truncated } = buildDesktopConversation(capture);
      // Counts only: what the conversation says is never logged.
      log("desktop-save-started", { requestId: payload.requestId, provider: payload.conversation.provider, turns, truncated, port: desktop.port });
      await show(describeDesktopSavePhase("connecting"));
      const session = await sendToDesktop({ port: desktop.port, payload, fetch });
      await show(describeDesktopSavePhase("waiting"));
      const result = await waitForDesktopResult({ session, fetch, sleep, now, onTick: () => show(describeDesktopSavePhase("waiting")) });
      return await finish(show, result);
    } catch (err) {
      const reason = err instanceof DesktopError ? err.reason : "desktop-not-responding";
      log("desktop-save-failed", { reason, detail: err instanceof Error ? err.message : String(err) });
      return await finish(show, { reason });
    } finally {
      running.delete(key);
    }
  };

  async function finish(show, outcome) {
    const toast = { ...describeDesktopSave(outcome), final: true };
    await show(toast);
    log("desktop-save-finished", { status: outcome.status ?? outcome.reason, saved: outcome.saved, turns: outcome.turns });
    return { ...outcome, toast };
  }
}
