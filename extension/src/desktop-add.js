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
  buildDesktopPayload,
  describeDesktopPhase,
  describeDesktopResult,
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
