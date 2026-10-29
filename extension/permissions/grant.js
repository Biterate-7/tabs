import { MSG_AI_PERMISSION_ANSWER, TRANSFER_PROVIDERS } from "../src/ai-transfer.js";

/**
 * The window background.js opens when a Use in AI transfer needs an AI app's
 * optional host permission. Chrome asks for a permission only from a click
 * in an extension page, so this page is that click: it says what the access
 * is for, asks Chrome for exactly that app's origins, and tells the
 * background the answer (which then carries the transfer on, or stops it).
 */
export function initGrant(doc = document, search = location.search) {
  const params = new URLSearchParams(search);
  const provider = params.get("provider");
  const opId = params.get("op") || "";
  const config = Object.prototype.hasOwnProperty.call(TRANSFER_PROVIDERS, provider) ? TRANSFER_PROVIDERS[provider] : undefined;
  const allow = doc.getElementById("grant-allow");
  const cancel = doc.getElementById("grant-cancel");
  const status = doc.getElementById("grant-status");
  if (!config) {
    doc.getElementById("grant-heading").textContent = "Nothing to allow";
    doc.getElementById("grant-why").textContent = "This window wasn't opened for an AI app Hubble knows. Close it and try again from Hubble.";
    allow.hidden = true;
    cancel.textContent = "Close";
    cancel.addEventListener("click", () => window.close());
    return;
  }
  const sites = config.hosts.filter((host) => !host.startsWith("www.")).join(" and ");
  if (params.get("purpose") === "context") {
    // Context detection: reading conversations to match them to projects. Same origins, different use — said plainly.
    doc.getElementById("grant-heading").textContent = `Let Hubble read your ${config.name} conversations?`;
    doc.getElementById("grant-why").textContent = `To suggest which project a ${config.name} conversation belongs to, Hubble for Chrome needs access to ${sites}.`;
    const list = doc.getElementById("grant-list");
    if (list) {
      list.replaceChildren(
        ...[
          "It reads the conversation in a tab you have open, a few seconds after it loads.",
          "It keeps only topic words and a message count on this computer — never the text.",
          "Nothing is sent anywhere. The text is saved only when you accept a suggestion.",
          "Turn it off in Hubble's Settings, or remove access in Chrome's extension settings.",
        ].map((line) => {
          const item = doc.createElement("li");
          item.textContent = line;
          return item;
        })
      );
    }
  } else {
    doc.getElementById("grant-heading").textContent = `Let Hubble use ${config.name}?`;
    doc.getElementById("grant-why").textContent = `To put what you chose in Hubble into a new ${config.name} chat, Hubble for Chrome needs access to ${sites}.`;
  }

  let answered = false;
  async function answer(granted) {
    if (answered) return;
    answered = true;
    try {
      await chrome.runtime.sendMessage({ type: MSG_AI_PERMISSION_ANSWER, payload: { opId, provider, granted } });
    } catch {
      // The background stopped waiting; Hubble's dialog says so and offers Try again.
    }
    window.close();
  }

  allow.addEventListener("click", async () => {
    allow.disabled = true;
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: config.origins });
    } catch {
      granted = false;
    }
    if (!granted) {
      allow.disabled = false;
      status.textContent = `Chrome didn't grant access to ${config.name}. Choose Allow in Chrome's prompt, or Not now.`;
      status.hidden = false;
      return;
    }
    await answer(true);
  });
  cancel.addEventListener("click", () => void answer(false));
}

if (typeof document !== "undefined" && document.getElementById("grant-allow")) initGrant();
