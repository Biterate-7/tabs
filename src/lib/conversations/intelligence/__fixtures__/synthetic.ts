import { messagesOf } from "../canonical";
import type { AiProviderId } from "@/lib/providers/registry";
import type { ConversationRecord } from "../types";

/**
 * A deterministic, generated corpus for *timing* the engine at 100–5,000
 * conversations. It is shaped like real use (projects, several AI apps,
 * long assistant replies, decisions, tasks, questions) but it is not real
 * history and says nothing about accuracy — quality is measured on the
 * hand-labelled set in ./relatedness-eval.ts, and on a person's own history
 * only through the in-app review.
 */

const SUBJECTS = [
  ["indexeddb", "transaction", "quota", "safari", "persistence", "storage", "reload"],
  ["oauth", "pkce", "redirect", "consent", "callback", "scope", "login"],
  ["webpack", "bundle", "chunk", "loader", "minify", "sourcemap", "build"],
  ["postgres", "migration", "index", "query", "vacuum", "schema", "replica"],
  ["kubernetes", "pod", "deployment", "ingress", "helm", "cluster", "autoscaler"],
  ["photosynthesis", "chlorophyll", "calvin", "glucose", "stomata", "light", "carbon"],
  ["sourdough", "starter", "hydration", "levain", "proof", "crumb", "flour"],
  ["marathon", "tempo", "mileage", "taper", "cadence", "recovery", "hamstring"],
  ["itinerary", "kyoto", "railpass", "ryokan", "shinkansen", "osaka", "temple"],
  ["essay", "thesis", "paragraph", "citation", "argument", "outline", "conclusion"],
  ["budget", "spreadsheet", "expenses", "categories", "savings", "monthly", "forecast"],
  ["tailwind", "utility", "variant", "breakpoint", "theme", "token", "layout"],
  ["regression", "coefficient", "residual", "variance", "dataset", "outlier", "model"],
  ["guitar", "chord", "fretboard", "strumming", "scale", "capo", "progression"],
  ["garden", "tomato", "compost", "seedling", "mulch", "watering", "pruning"],
  ["resume", "interview", "portfolio", "recruiter", "salary", "offer", "negotiation"],
  ["rust", "borrow", "lifetime", "trait", "cargo", "ownership", "async"],
  ["electron", "renderer", "preload", "ipc", "packaging", "updater", "sandbox"],
  ["camera", "aperture", "shutter", "exposure", "lens", "iso", "composition"],
  ["chess", "opening", "endgame", "tactics", "gambit", "pawn", "castling"],
] as const;

const FILLER = [
  "That is a reasonable way to think about it.",
  "There are a few things worth checking first.",
  "In practice this depends on how you plan to use it.",
  "Here is a short explanation of how the pieces fit together.",
  "It helps to separate the concerns before changing anything.",
  "Most people run into this at some point.",
  "Keep an eye on the edge cases while you test it.",
  "The documentation covers this in more detail.",
];

const PROVIDERS: AiProviderId[] = ["chatgpt", "claude", "gemini", "perplexity"];
const DAY = 86_400_000;

function rng(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

export type SyntheticCorpus = { records: ConversationRecord[]; workspaceIds: string[]; chars: number };

/** `count` conversations over `count / 25` projects, each project about one or two subjects. */
export function syntheticCorpus(count: number, seed = 7, now = Date.UTC(2026, 9, 30)): SyntheticCorpus {
  const random = rng(seed);
  const pick = <T,>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
  const projects = Math.max(4, Math.round(count / 25));
  const records: ConversationRecord[] = [];
  let chars = 0;
  for (let index = 0; index < count; index++) {
    const workspace = Math.floor(random() * projects);
    const subject = SUBJECTS[(workspace * 3 + (random() < 0.7 ? 0 : 1)) % SUBJECTS.length]!;
    const words = () => Array.from({ length: 3 }, () => pick(subject));
    const turns: { role: "user" | "assistant"; text: string }[] = [];
    const length = 4 + Math.floor(random() * 12);
    for (let turn = 0; turn < length; turn++) {
      if (turn % 2 === 0) {
        const [a, b, c] = words();
        const kinds = [
          `How do I fix the ${a} problem with ${b}? It keeps failing when the ${c} changes.`,
          `Let's go with the ${a} approach for ${b}.`,
          `I need to update the ${a} and check the ${b} before Friday.`,
          `I'm thinking about switching the ${a} to a different ${b}. Should I?`,
          `That worked, the ${a} is fine now.`,
          `It's still not working after changing the ${c}. Why would ${a} break?`,
        ];
        turns.push({ role: "user", text: pick(kinds) });
      } else {
        const sentences: string[] = [];
        const size = 6 + Math.floor(random() * 14);
        for (let s = 0; s < size; s++) {
          const [a, b, c] = words();
          sentences.push(
            random() < 0.35
              ? pick(FILLER)
              : pick([
                  `The ${a} usually depends on the ${b}, so start by checking the ${c}.`,
                  `I'd recommend keeping the ${a} separate from the ${b}.`,
                  `You could adjust the ${a} and measure the ${b} again.`,
                  `A common cause is a mismatch between the ${a} and the ${c}.`,
                  `When the ${b} grows, the ${a} needs more attention.`,
                ])
          );
        }
        turns.push({ role: "assistant", text: sentences.join(" ") + (random() < 0.3 ? `\n\nNext steps:\n- Review the ${pick(subject)}\n- Test the ${pick(subject)}` : "") });
      }
    }
    const id = `w${workspace}:s:t${index}`;
    const at = now - Math.floor(random() * 180) * DAY;
    const messages = messagesOf(id, turns);
    chars += turns.reduce((sum, turn) => sum + turn.text.length, 0);
    records.push({
      id,
      identity: `synthetic:chat:${index}`,
      workspaceId: `w${workspace}`,
      ref: { kind: "source", tabId: `t${index}` },
      provider: PROVIDERS[index % PROVIDERS.length],
      title: `${subject[0]} ${subject[index % subject.length]} question ${index}`,
      createdAt: at,
      updatedAt: at,
      syncedAt: at,
      ingestion: "ready",
      contentHash: `h${seed}-${index}`,
      messages,
    });
  }
  return { records, workspaceIds: Array.from({ length: projects }, (_, index) => `w${index}`), chars };
}
