import { a, record, u, NOW, DAY } from "./conversations";
import type { AiProviderId } from "@/lib/providers/registry";
import type { ConversationTurn } from "@/lib/resources/types";
import type { EvalConversation } from "./relatedness-eval";

/**
 * A second hand-labelled set, written after the relatedness thresholds were
 * chosen on ./relatedness-eval.ts and never used to choose them: the
 * held-out check that they are not fitted to that set alone. Same labelling
 * rules, different subjects and different traps ("pod", "memory",
 * "Spanish", "helm", "toast").
 */

function chat(id: string, provider: AiProviderId, workspaceId: string, days: number, title: string, labels: Omit<EvalConversation, "record">, turns: ConversationTurn[]): EvalConversation {
  return { record: record(id, turns, { provider, workspaceId, title, updatedAt: NOW - days * DAY }), ...labels };
}

export const HOLDOUT_SET: EvalConversation[] = [
  chat("oom-restarts", "chatgpt", "infra", 10, "Pods keep restarting", { project: "infra", problem: "oom-kills", topics: ["devops"] }, [
    u("My pods keep restarting every few hours and kubectl describe shows OOMKilled. What's going on?"),
    a("The container exceeded its memory limit and the kernel killed it. Check the limit in the pod spec against what the process actually uses, and look for a leak if usage grows steadily until the kill."),
    u("Usage climbs steadily, so it looks like a leak in the worker."),
  ]),
  chat("helm-limits", "claude", "infra", 9, "Memory requests and limits in the chart", { project: "infra", problem: "oom-kills", topics: ["devops"] }, [
    u("How should I set resources.requests.memory and resources.limits.memory in our Helm chart for the worker deployment?"),
    a("Set the request to the worker's typical usage and the limit somewhat above its peak, so the scheduler places it sensibly and a spike doesn't get it killed. Expose both as values so each environment can override them."),
  ]),
  chat("grafana-memory", "gemini", "infra", 7, "Dashboard for container memory", { project: "infra", problem: "observability", topics: ["devops"] }, [
    u("Build a Grafana panel that shows memory usage per container over the last week."),
    a("Plot container_memory_working_set_bytes grouped by container and pod, with the limit from kube_pod_container_resource_limits as a second series, so you can see how close each one runs to it."),
  ]),
  chat("wedding-speech", "claude", "wedding", 30, "Best man speech draft", { project: "wedding", problem: "wedding-speech", topics: ["writing", "events"] }, [
    u("Help me write a five-minute best man speech for my brother's wedding. We grew up sharing a room and he's marrying his university sweetheart."),
    a("Open with a short story from the shared bedroom years, move to how he changed after meeting her, give one moment that shows them as a couple, and close by raising a glass to both of them."),
  ]),
  chat("speech-jokes", "chatgpt", "wedding", 28, "Jokes for the toast", { project: "wedding", problem: "wedding-speech", topics: ["writing", "events"] }, [
    u("Give me a few gentle jokes about my brother for the toast at his wedding, nothing that would embarrass the bride's family."),
    a("Keep the jokes about him and affectionate: his terrible sense of direction, the year he tried to grow a moustache, how long it took him to work up the courage to ask her out."),
  ]),
  chat("venue-budget", "gemini", "wedding", 60, "Venue costs", { project: "wedding", problem: "wedding-budget", topics: ["events", "budgeting"] }, [
    u("We have 120 guests. Compare a country house venue with an all-inclusive hotel package on total cost."),
    a("Country houses often charge a hire fee and then catering per head; hotel packages bundle food, drink and rooms. Put both into a spreadsheet with per-head and fixed costs to compare like for like."),
  ]),
  chat("subjunctive", "chatgpt", "spanish", 40, "When to use the subjunctive", { project: "spanish", problem: "spanish-grammar", topics: ["language-learning"] }, [
    u("I'm learning Spanish. When do I use the subjunctive instead of the indicative?"),
    a("Use the subjunctive after expressions of wishes, doubt, emotion and requests when the subject changes, as in Quiero que vengas, and the indicative for statements of fact."),
  ]),
  chat("ser-estar", "claude", "spanish", 38, "Ser vs estar", { project: "spanish", problem: "spanish-grammar", topics: ["language-learning"] }, [
    u("I keep mixing up ser and estar. Is there a simple rule?"),
    a("Ser is for what something is: identity, origin, time, characteristics. Estar is for states and location: how something is right now and where it is."),
  ]),
  chat("mexico-phrases", "perplexity", "mexico-trip", 20, "Phrases for travelling in Mexico", { project: "mexico-trip", problem: "trip-phrases", topics: ["language-learning", "travel"] }, [
    u("What Spanish phrases will I need most when travelling around Mexico City for a week?"),
    a("Greetings and please and thank you, asking for directions and prices, ordering food, and asking for the bill (la cuenta, por favor) cover most days."),
  ]),
  chat("coffee-pods", "gemini", "home", 12, "Descaling a coffee pod machine", { project: "home", problem: "coffee-machine", topics: ["home"] }, [
    u("My coffee pod machine is slow and the coffee tastes bitter. How do I descale it?"),
    a("Run a descaling solution through the machine without a pod, then two full tanks of clean water. In hard-water areas, repeat every three months."),
  ]),
  chat("parent-memory", "claude", "family", 16, "Dad's memory", { project: "family", problem: "parent-health", topics: ["health"] }, [
    u("My father keeps forgetting recent conversations and repeating questions. When should we see a doctor?"),
    a("Repeated short-term memory lapses that affect daily life are worth a GP appointment soon. Note examples and dates beforehand, and go with him if he's comfortable with that."),
  ]),
  chat("tortilla", "chatgpt", "kitchen", 26, "Spanish omelette", { project: "kitchen", problem: "tortilla", topics: ["cooking"] }, [
    u("How do I make a proper Spanish tortilla without it falling apart when I flip it?"),
    a("Cook the potatoes and onion slowly in plenty of oil, let the egg mixture sit with them for a few minutes, and use a plate the size of the pan to flip it in one confident move."),
  ]),
  chat("sailboat-helm", "perplexity", "sailing", 33, "Heavy helm when sailing", { project: "sailing", problem: "weather-helm", topics: ["sailing"] }, [
    u("My sailboat's helm gets very heavy and the boat keeps turning into the wind in gusts. How do I fix it?"),
    a("That's weather helm. Ease the mainsheet or traveller in gusts, reef earlier, and move the jib lead so the sails are balanced."),
  ]),
];
