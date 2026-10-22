/**
 * Which glyph a project wears when the user hasn't uploaded an image: chosen
 * from the project's title (and, failing that, its brief), never from random
 * state, so the same project always draws the same mark on every screen and
 * after every reload. A title that names no subject gets the plain folder.
 * Pure — the drawing lives in project-icon.tsx.
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
  | "folder";

/** Ordered: the first topic a title matches wins, so the more specific topics come first. */
const TOPICS: readonly { glyph: ProjectGlyph; match: RegExp }[] = [
  { glyph: "math", match: /\b(math|maths|mathematics|mathematical|algebra|calculus|geometry|trigonometry|statistics|stats|probability|arithmetic|topology|linear algebra|discrete|numeracy)\b/ },
  { glyph: "biology", match: /\b(bio|biology|biological|genetics|genome|dna|anatomy|medicine|medical|health|nursing|neuroscience|psychology|ecology|botany|zoology|pharmacy|nutrition|fitness)\b/ },
  { glyph: "science", match: /\b(physics|chemistry|chem|quantum|astronomy|astrophysics|cosmology|science|sciences|engineering|mechanics|thermodynamics|materials|electronics|robotics)\b/ },
  { glyph: "code", match: /\b(code|coding|programming|software|developer|development|dev|app|api|frontend|backend|web|website|javascript|typescript|python|rust|java|golang|sql|database|devops|github|repo|cli|algorithms?|data structures|machine learning|ml|ai|llm|cs\d*|computer science|compsci)\b/ },
  { glyph: "history", match: /\b(history|historical|ancient|medieval|archaeology|civilization|civilisation|empire|dynasty|war|revolution|classics|antiquity|museum|heritage|politics|government|law|legal)\b/ },
  { glyph: "research", match: /\b(research|thesis|dissertation|literature review|study|studies|paper|papers|experiment|lab|survey|investigation|analysis|journal|phd|capstone)\b/ },
  { glyph: "writing", match: /\b(writing|essay|essays|novel|book|books|reading|literature|english|poetry|poems?|story|stories|blog|journal(?:ing)?|notes?|philosophy|ethics|theology|religion)\b/ },
  { glyph: "design", match: /\b(design|art|arts|drawing|painting|photography|photo|illustration|ui|ux|brand|branding|creative|fashion|architecture|film|video|animation)\b/ },
  { glyph: "music", match: /\b(music|song|songs|audio|guitar|piano|band|sound|podcast|composition|theory)\b/ },
  { glyph: "business", match: /\b(business|finance|financial|economics|economy|marketing|startup|sales|investing|investment|accounting|strategy|product|career|job|jobs|interview|resume|budget|money|crypto)\b/ },
  { glyph: "world", match: /\b(language|languages|spanish|french|german|japanese|chinese|korean|hindi|latin|travel|trip|geography|culture|world|global|europe|asia|africa|vacation|holiday)\b/ },
];

/** The mark for a project whose title says nothing about its subject. */
export const DEFAULT_PROJECT_ICON: { glyph: ProjectGlyph } = { glyph: "folder" };

function topicOf(text: string): { glyph: ProjectGlyph } | null {
  const lowered = text.toLowerCase();
  if (!lowered.trim()) return null;
  for (const topic of TOPICS) if (topic.match.test(lowered)) return { glyph: topic.glyph };
  return null;
}

/**
 * The glyph for a project. The title decides first; the brief is only
 * consulted when the title names no subject ("Fall term"), and a project that
 * matches nothing at all is a plain folder.
 */
export function resolveProjectIcon(name: string, context = ""): { glyph: ProjectGlyph } {
  const title = (typeof name === "string" ? name : "").trim();
  return topicOf(title) ?? topicOf(context) ?? DEFAULT_PROJECT_ICON;
}
