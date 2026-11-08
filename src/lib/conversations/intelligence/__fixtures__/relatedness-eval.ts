import { a, record, u, NOW, DAY } from "./conversations";
import type { AiProviderId } from "@/lib/providers/registry";
import type { ConversationTurn } from "@/lib/resources/types";
import type { ConversationRecord } from "../types";

/**
 * A hand-written, hand-labelled set for measuring whether Hubble links the
 * right conversations — written for this purpose, not taken from anyone's
 * history. It is built to be hard in both directions:
 *
 *   - the same work in different words (sign-in architecture / sessions that
 *     expire / where to keep refresh tokens) that share almost no vocabulary;
 *   - look-alikes that share words but not meaning (a therapy "session",
 *     counting LLM "tokens", "authenticating" a watch, a ball "python");
 *   - the same subject in two different projects (a React state bug in
 *     Hubble and another in a client's shop).
 *
 * Every conversation carries its ground truth: the project it belongs to,
 * the underlying problem, and its broader topics. A pair's truth is the
 * strongest of: same problem › same project › shared topic › unrelated.
 * These labels measure the engine on this set only; quality on a person's
 * real history is measured from their own reviews (lib/…/review.ts).
 */

export type TruthLevel = "same-problem" | "same-project" | "related-topic" | "unrelated";

export type EvalConversation = {
  record: ConversationRecord;
  project: string;
  problem: string;
  topics: string[];
};

const at = (days: number) => NOW - days * DAY;

function chat(id: string, provider: AiProviderId, workspaceId: string, days: number, title: string, labels: Omit<EvalConversation, "record">, turns: ConversationTurn[]): EvalConversation {
  return { record: record(id, turns, { provider, workspaceId, title, updatedAt: at(days) }), ...labels };
}

export const EVAL_SET: EvalConversation[] = [
  // ── Hubble: securing sign-in, in three vocabularies ─────────────────────
  chat("auth-architecture", "claude", "hubble-web", 20, "Sign-in architecture for a web and desktop app", { project: "hubble", problem: "sign-in-security", topics: ["security", "web-dev"] }, [
    u("I'm designing authentication for an app that has a web version and a desktop version. Should the desktop app open the browser for sign-in or have its own login form?"),
    a("Opening the system browser is the safer pattern. The desktop app starts an OAuth authorization code flow with PKCE, the person signs in on the website they already trust, and the browser hands a one-time code back to the app through a deep link. The app never sees the password, and you can reuse the web sign-in, including any second factor."),
    u("Let's go with the browser flow and PKCE. How does the app prove the code was meant for it?"),
    a("The app creates a random code verifier, sends only its hash as the code challenge, and later presents the verifier when it exchanges the code. A code intercepted by another program is useless without the verifier."),
  ]),
  chat("session-expiry", "chatgpt", "hubble-web", 14, "Users randomly logged out", { project: "hubble", problem: "sign-in-security", topics: ["security", "web-dev"] }, [
    u("People keep getting kicked out of my web app after about an hour even when they're active. Where should I look?"),
    a("That pattern points to a fixed session lifetime. If the session cookie expires an hour after it was issued, activity doesn't extend it. Two common fixes: a sliding expiry that renews the cookie on each request, or a short-lived session plus a longer-lived renewal step that runs quietly in the background."),
    u("I'll add a sliding expiry and renew the cookie on each request. Should the cookie be HttpOnly?"),
    a("Yes. Mark it HttpOnly, Secure and SameSite=Lax so page scripts can't read it and other sites can't send it along with their requests."),
  ]),
  chat("token-storage", "gemini", "hubble-desktop", 9, "Where should the desktop app keep credentials?", { project: "hubble", problem: "sign-in-security", topics: ["security", "desktop"] }, [
    u("My Tauri app receives a refresh token after the person signs in. Where should I store it so another program on the machine can't just read it from disk?"),
    a("Use the operating system's credential store rather than a file: Windows Credential Manager, the macOS Keychain or the Secret Service on Linux. Keep the access token in memory only, rotate the refresh token every time it is used, and revoke it on sign-out."),
    u("We decided to keep it in the Windows Credential Manager and rotate it on every use."),
  ]),

  // ── Hubble: saved data going missing ─────────────────────────────────────
  chat("indexeddb-loss", "chatgpt", "hubble-web", 30, "IndexedDB writes lost after reload", { project: "hubble", problem: "data-loss", topics: ["storage", "web-dev"] }, [
    u("My app loses saved conversations after a reload. The IndexedDB write seems to fail silently. How do I debug this?"),
    a("This usually happens when the transaction closes before the write finishes. Wrap the write in a promise that resolves on oncomplete and rejects on onerror, so a failed write surfaces instead of disappearing."),
    u("That worked in Chrome, but it's still failing in Safari private windows."),
  ]),
  chat("safari-quota", "perplexity", "hubble-web", 28, "Safari private browsing storage limits", { project: "hubble", problem: "data-loss", topics: ["storage", "web-dev"] }, [
    u("Does Safari private browsing block IndexedDB?"),
    a("IndexedDB works in Safari private windows since Safari 14, but the data is discarded when the window closes and the quota is much smaller. Writes over the quota fail with a QuotaExceededError."),
    u("So I need an in-memory fallback when the quota is exceeded."),
  ]),
  chat("storage-adapter", "claude", "hubble-desktop", 25, "Storage adapter for web and desktop", { project: "hubble", problem: "storage-architecture", topics: ["storage", "desktop"] }, [
    u("Should Hubble keep conversations in IndexedDB on desktop too, or move to SQLite through Tauri?"),
    a("A storage adapter with two backends keeps both options open: IndexedDB in the browser build, SQLite in the desktop build. The rest of the app talks to put, get and delete and never knows which one is underneath."),
    u("We decided to use a storage adapter with IndexedDB on the web and SQLite in Tauri."),
  ]),

  // ── Hubble and a client shop: the same kind of bug, two projects ────────
  chat("sidebar-stale", "chatgpt", "hubble-web", 6, "Sidebar count doesn't refresh", { project: "hubble", problem: "hubble-stale-ui", topics: ["react", "web-dev"] }, [
    u("After deleting a project the sidebar still shows the old count until I reload. The count comes from a useMemo over the projects list."),
    a("The memo's dependency is probably the same array reference after the delete, because the list was mutated in place. Return a new array from the delete so React sees the change, and the memo recomputes."),
    u("That was it — the delete used splice. Fixed by returning a filtered copy."),
  ]),
  chat("cart-stale", "claude", "shopfront", 5, "Cart total wrong after removing an item", { project: "shopfront", problem: "shop-cart-bug", topics: ["react", "web-dev"] }, [
    u("In the client's shop, removing an item from the cart leaves the total unchanged until another click. The handler reads cart from useState."),
    a("The handler is closing over an old value of cart. Use the functional form, setCart(previous => previous.filter(...)), and derive the total from the new state instead of keeping it in a second state variable."),
    u("I'll switch to the functional update and compute the total from the cart."),
  ]),

  // ── Biology exam preparation ─────────────────────────────────────────────
  chat("photosynthesis", "gemini", "biology", 12, "How photosynthesis works", { project: "biology", problem: "photosynthesis-exam", topics: ["plant-biology"] }, [
    u("Explain how photosynthesis converts light into chemical energy, for my biology exam."),
    a("Photosynthesis happens in two stages. The light-dependent reactions in the thylakoid membranes capture light and make ATP and NADPH. The Calvin cycle in the stroma uses them to fix carbon dioxide into sugar."),
    u("What limits the rate of the Calvin cycle?"),
  ]),
  chat("leaf-colour", "chatgpt", "biology", 11, "Why leaves are green", { project: "biology", problem: "photosynthesis-exam", topics: ["plant-biology"] }, [
    u("Why are leaves green? I need to explain absorption spectra in my revision notes."),
    a("Chlorophyll a and b absorb strongly in the blue and red parts of the spectrum and reflect green, so the light that reaches your eye from a leaf is mostly green. That absorbed red and blue light is what drives the light-dependent reactions."),
  ]),
  chat("houseplant-light", "perplexity", "home", 3, "Low-light houseplants", { project: "home", problem: "houseplants", topics: ["plant-biology", "home"] }, [
    u("Which houseplants survive in a north-facing room with little direct sun?"),
    a("Snake plants, ZZ plants, pothos and peace lilies all tolerate low light. They grow slowly in shade, so water them less often than you would in a bright room."),
  ]),

  // ── Baking ──────────────────────────────────────────────────────────────
  chat("starter", "chatgpt", "kitchen", 40, "Sourdough starter not rising", { project: "kitchen", problem: "sourdough", topics: ["baking"] }, [
    u("My sourdough starter barely rises anymore. I feed it once a day with all-purpose flour."),
    a("Move it somewhere warmer, around 24–26°C, and feed it twice a day for a few days with some wholegrain rye or wholewheat mixed in. It should double within six hours once it's active again."),
    u("I'll switch to twice-daily feeds with some rye."),
  ]),
  chat("dense-crumb", "claude", "kitchen", 33, "Dense, gummy loaf", { project: "kitchen", problem: "sourdough", topics: ["baking"] }, [
    u("My loaves come out dense and gummy inside even though the crust looks fine."),
    a("Usually that's underproofing or cutting too soon. Let the bulk ferment go until the dough has grown about 50% and feels airy, and wait at least an hour after baking before slicing, because the crumb is still setting."),
  ]),

  // ── Japan trip ─────────────────────────────────────────────────────────
  chat("kyoto-itinerary", "chatgpt", "japan", 50, "Five days in Kyoto and Osaka", { project: "japan", problem: "japan-itinerary", topics: ["travel"] }, [
    u("Plan five days split between Kyoto and Osaka in April. I like temples and food markets."),
    a("Base yourself in Kyoto for three nights: Fushimi Inari early on the first morning, Arashiyama on the second, Gion and Nishiki Market in the evenings. Then two nights in Osaka for Kuromon Market and Dotonbori, with a half day in Nara."),
    u("Let's do three nights in Kyoto and two in Osaka."),
  ]),
  chat("rail-pass", "gemini", "japan", 48, "Is the JR Pass worth it?", { project: "japan", problem: "japan-itinerary", topics: ["travel"] }, [
    u("Is a 7-day JR Pass worth it if I fly into Tokyo, go to Kyoto, then Osaka and back?"),
    a("After the 2023 price rise, a Tokyo–Kyoto–Osaka–Tokyo loop usually costs less with individual shinkansen tickets than with a 7-day pass, unless you add more long trips such as Hiroshima."),
  ]),
  chat("ryokan-etiquette", "claude", "japan", 46, "Staying at a ryokan", { project: "japan", problem: "japan-etiquette", topics: ["travel"] }, [
    u("What should I know before staying at a traditional ryokan for the first time?"),
    a("Take your shoes off at the entrance, wear the yukata provided, wash before entering the shared bath and keep towels out of the water. Dinner is usually served at a set time, so tell them if you'll arrive late."),
  ]),

  // ── Running ────────────────────────────────────────────────────────────
  chat("marathon-plan", "chatgpt", "running", 60, "16-week marathon plan", { project: "running", problem: "marathon-training", topics: ["fitness"] }, [
    u("Build me a 16-week plan for my first marathon. I run about 30 km a week now."),
    a("Build mileage by about 10% a week with every fourth week easier, one long run on weekends growing to 32 km, one tempo session midweek, and a three-week taper before race day."),
  ]),
  chat("knee-pain", "claude", "running", 52, "Knee pain on long runs", { project: "running", problem: "running-injury", topics: ["fitness", "health"] }, [
    u("The outside of my knee hurts after about 15 km on long runs. It goes away when I stop."),
    a("Pain on the outside of the knee that appears at a predictable distance often comes from the iliotibial band. Cut the long run back for a couple of weeks, add hip strength work, and see a physiotherapist if it doesn't improve."),
  ]),

  // ── An essay ───────────────────────────────────────────────────────────
  chat("essay-thesis", "claude", "essay", 18, "Thesis for a climate policy essay", { project: "essay", problem: "climate-essay", topics: ["writing", "climate"] }, [
    u("Help me sharpen the thesis for my essay arguing that carbon pricing is the most effective climate policy."),
    a("Make it arguable and specific: 'A carbon price that rises predictably and returns revenue to households cuts emissions at lower cost than regulation alone, and is more durable politically.' Each body paragraph then defends one clause."),
  ]),
  chat("carbon-evidence", "perplexity", "essay", 17, "Carbon tax vs cap-and-trade evidence", { project: "essay", problem: "climate-essay", topics: ["climate"] }, [
    u("What does the evidence say about British Columbia's carbon tax and the EU emissions trading system?"),
    a("Studies of British Columbia's carbon tax find emissions fell 5–15% relative to elsewhere with little effect on growth. The EU ETS cut emissions in covered sectors, especially after the 2018 reforms tightened the cap."),
  ]),

  // ── Look-alikes: shared words, different meanings ─────────────────────
  chat("therapy-session", "chatgpt", "practice", 8, "Session notes template", { project: "practice", problem: "session-notes", topics: ["counselling"] }, [
    u("I'm a counsellor. Give me a template for notes after each therapy session with a client."),
    a("A common structure is SOAP: Subjective (what the client reported), Objective (what you observed), Assessment (your clinical impression) and Plan (next steps and the date of the next session)."),
  ]),
  chat("llm-tokens", "claude", "side-project", 7, "Cutting the token count of prompts", { project: "side-project", problem: "prompt-cost", topics: ["ai-cost"] }, [
    u("My chatbot's API bill is high. How can I reduce the number of tokens each prompt uses?"),
    a("Trim the system prompt, summarise older turns instead of resending them, and cache repeated context. Count tokens with the provider's tokenizer before sending so you can see where they go."),
  ]),
  chat("watch-authentic", "gemini", "collecting", 15, "Is this vintage watch authentic?", { project: "collecting", problem: "watch-authentication", topics: ["collecting"] }, [
    u("How can I tell whether a vintage Omega Seamaster is authentic before I buy it?"),
    a("Check that the serial and reference numbers match the production year, open the caseback to confirm the movement calibre, and compare the dial printing with known originals. Ask the seller for service papers."),
  ]),
  chat("ball-python", "chatgpt", "home", 22, "Ball python humidity", { project: "home", problem: "pet-care", topics: ["pets"] }, [
    u("What humidity does a ball python enclosure need? Mine is shedding in pieces."),
    a("Keep humidity between 50 and 60%, and raise it to around 70% during a shed. A humid hide with damp moss helps the skin come off in one piece."),
  ]),
  chat("rename-script", "claude", "side-project", 21, "Script to rename photos by date", { project: "side-project", problem: "photo-renaming", topics: ["scripting"] }, [
    u("Write a Python script that renames my photos by the date they were taken."),
    a("Read each file's EXIF DateTimeOriginal with Pillow, format it as YYYY-MM-DD_HHMMSS and rename the file, adding a counter when two photos share a timestamp."),
  ]),
  chat("moving-boxes", "perplexity", "home", 35, "Packing for a move", { project: "home", problem: "moving-house", topics: ["home"] }, [
    u("How many boxes do I need to move out of a two-bedroom flat, and should I rent a storage unit?"),
    a("A two-bedroom flat usually takes 40–60 boxes. A storage unit only makes sense if there's a gap between leaving and moving in, or you're downsizing."),
  ]),
];

/** The labelled truth for a pair, strongest first. */
export function truthOf(x: EvalConversation, y: EvalConversation): TruthLevel {
  if (x.problem === y.problem) return "same-problem";
  if (x.project === y.project) return "same-project";
  if (x.topics.some((topic) => y.topics.includes(topic))) return "related-topic";
  return "unrelated";
}
