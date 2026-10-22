/**
 * Which glyph a project wears when the user hasn't uploaded an image: chosen
 * from the project's title (and, failing that, its brief), never from random
 * state, so the same project always draws the same mark on every screen and
 * after every reload. Pure — the drawing lives in project-icon.tsx.
 */

export type ProjectGlyph =
  | "math"
  | "history"
  | "code"
  | "research"
  | "science"
  | "biology"
  | "writing"
  | "design"
  | "music"
  | "business"
  | "world"
  | "nebula"
  | "comet"
  | "constellation"
  | "ringed"
  | "crescent"
  | "star";

export type ProjectTone = "blue" | "violet" | "cyan";

/** Hue (oklch degrees) of each accent — restrained blue / violet / cyan, nothing warmer. */
export const TONE_HUE: Record<ProjectTone, number> = { blue: 245, violet: 292, cyan: 205 };

/** Ordered: the first topic a title matches wins, so the more specific topics come first. */
const TOPICS: readonly { glyph: ProjectGlyph; tone: ProjectTone; match: RegExp }[] = [
  { glyph: "math", tone: "violet", match: /\b(math|maths|mathematics|mathematical|algebra|calculus|geometry|trigonometry|statistics|stats|probability|arithmetic|topology|linear algebra|discrete|numeracy)\b/ },
  { glyph: "biology", tone: "cyan", match: /\b(bio|biology|biological|genetics|genome|dna|anatomy|medicine|medical|health|nursing|neuroscience|psychology|ecology|botany|zoology|pharmacy|nutrition|fitness)\b/ },
  { glyph: "science", tone: "blue", match: /\b(physics|chemistry|chem|quantum|astronomy|astrophysics|cosmology|science|sciences|engineering|mechanics|thermodynamics|materials|electronics|robotics)\b/ },
  { glyph: "code", tone: "cyan", match: /\b(code|coding|programming|software|developer|development|dev|app|api|frontend|backend|web|website|javascript|typescript|python|rust|java|golang|sql|database|devops|github|repo|cli|algorithms?|data structures|machine learning|ml|ai|llm|cs\d*|computer science|compsci)\b/ },
  { glyph: "history", tone: "violet", match: /\b(history|historical|ancient|medieval|archaeology|civilization|civilisation|empire|dynasty|war|revolution|classics|antiquity|museum|heritage|politics|government|law|legal)\b/ },
  { glyph: "research", tone: "blue", match: /\b(research|thesis|dissertation|literature review|study|studies|paper|papers|experiment|lab|survey|investigation|analysis|journal|phd|capstone)\b/ },
  { glyph: "writing", tone: "violet", match: /\b(writing|essay|essays|novel|book|books|reading|literature|english|poetry|poems?|story|stories|blog|journal(?:ing)?|notes?|philosophy|ethics|theology|religion)\b/ },
  { glyph: "design", tone: "cyan", match: /\b(design|art|arts|drawing|painting|photography|photo|illustration|ui|ux|brand|branding|creative|fashion|architecture|film|video|animation)\b/ },
  { glyph: "music", tone: "violet", match: /\b(music|song|songs|audio|guitar|piano|band|sound|podcast|composition|theory)\b/ },
  { glyph: "business", tone: "blue", match: /\b(business|finance|financial|economics|economy|marketing|startup|sales|investing|investment|accounting|strategy|product|career|job|jobs|interview|resume|budget|money|crypto)\b/ },
  { glyph: "world", tone: "cyan", match: /\b(language|languages|spanish|french|german|japanese|chinese|korean|hindi|latin|travel|trip|geography|culture|world|global|europe|asia|africa|vacation|holiday)\b/ },
];

/** The unthemed pool, for titles that say nothing about their subject. */
const ABSTRACT: readonly { glyph: ProjectGlyph; tone: ProjectTone }[] = [
  { glyph: "nebula", tone: "violet" },
  { glyph: "constellation", tone: "blue" },
  { glyph: "comet", tone: "cyan" },
  { glyph: "ringed", tone: "blue" },
  { glyph: "crescent", tone: "violet" },
  { glyph: "star", tone: "cyan" },
];

/** The mark for a project with no name at all: Hubble's own four-point star. */
export const DEFAULT_PROJECT_ICON: { glyph: ProjectGlyph; tone: ProjectTone } = { glyph: "star", tone: "blue" };

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function topicOf(text: string): { glyph: ProjectGlyph; tone: ProjectTone } | null {
  const lowered = text.toLowerCase();
  if (!lowered.trim()) return null;
  for (const topic of TOPICS) if (topic.match.test(lowered)) return { glyph: topic.glyph, tone: topic.tone };
  return null;
}

/**
 * The glyph and accent for a project. The title decides first; the brief is
 * only consulted when the title names no subject ("Fall term"), and a title
 * that matches nothing at all gets one of the abstract marks, picked by a
 * hash of the title so two projects rarely share one.
 */
export function resolveProjectIcon(name: string, context = ""): { glyph: ProjectGlyph; tone: ProjectTone } {
  const title = (typeof name === "string" ? name : "").trim();
  if (!title && !context.trim()) return DEFAULT_PROJECT_ICON;
  const byTitle = topicOf(title);
  if (byTitle) return byTitle;
  const byContext = topicOf(context);
  if (byContext) return byContext;
  return ABSTRACT[hash(title || context) % ABSTRACT.length]!;
}
