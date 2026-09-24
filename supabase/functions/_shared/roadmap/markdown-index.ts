/**
 * The roadmap, as something a question can be asked of.
 *
 * One Markdown file is the whole knowledge base (docs/architecture/ARC_IMPLEMENTATION_ROADMAP.md),
 * so this is not a vector store. It is the file cut at its own headings, each section scored
 * against the question by plain keyword relevance, with prompt identifiers treated as the
 * exact keys they are. Deterministic on purpose: the same file and the same question always
 * select the same excerpts, which is what lets a test say which section answers what.
 *
 * Nothing in here knows what the roadmap says. It knows how roadmaps are shaped — headings,
 * numbered sections, `ARC-…` identifiers, a header block with a revision date — and it treats
 * a few headings as the current position (the document's first section, and any heading that
 * names the execution position, the next task or the implementation sequence). Those go to the
 * model with every question, so "what is next?" is answered from whatever the file says today.
 *
 * Pure TypeScript with no imports, so node's test runner loads it as-is.
 */

export type IdRange = { prefix: string; lo: number; hi: number; text: string };

export type RoadmapSection = {
  /** stable slug of the heading path, unique within the document */
  id: string;
  /** the heading text with its markdown removed */
  title: string;
  /** what a citation prints: "§4 Revised canonical implementation sequence" */
  label: string;
  level: number;
  /** the heading line and its body, as written */
  text: string;
  startLine: number;
  endLine: number;
  /** a current-position section, sent with every question */
  anchor: boolean;
  /** heading only, nothing under it before the next heading */
  empty: boolean;
  /** every prompt identifier the section mentions, normalised */
  ids: string[];
  /** "ARC-LR-4n0 through ARC-LR-4m0" style spans the section mentions */
  ranges: IdRange[];
  titleTerms: Map<string, number>;
  bodyTerms: Map<string, number>;
  length: number;
};

export type RoadmapIndex = {
  sha256: string;
  title: string | null;
  revised: string | null;
  sections: RoadmapSection[];
  ids: Set<string>;
  /** the categories the document itself uses in its identifiers (LR, OPT, …) */
  categories: Set<string>;
  df: Map<string, number>;
  avgLength: number;
};

export type Excerpt = {
  /** the label the model cites: S1, S2, … */
  ref: string;
  section: RoadmapSection;
  score: number;
};

export type Retrieval = {
  excerpts: Excerpt[];
  /** identifiers the question names that the roadmap never mentions */
  unknownIds: string[];
  /** identifiers the roadmap does not name but that fall inside a range it mentions */
  rangedIds: { id: string; range: IdRange }[];
  /** nothing in the question touches the roadmap at all */
  nothingMatched: boolean;
  /** the question names identifiers, the roadmap has none of them, and asks nothing else */
  onlyUnknownIds: boolean;
};

/* ── text ─────────────────────────────────────────────────────────────── */

const DASHES = /[‐-―−﹘﹣－]/g;

/** one hyphen, one quote style, compatibility forms folded. everything downstream reads this. */
export function normalizeText(text: string): string {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(DASHES, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"');
}

/** a heading as the roadmap wrote it, minus its markdown. what a citation prints. */
export function displayInline(text: string): string {
  return String(text ?? '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`+/g, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_]+)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** headings and labels without their markdown: backticks, emphasis, links. */
export function plainInline(text: string): string {
  return normalizeText(text)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`+/g, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_]+)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set(
  (
    'a about above after again all also am an and any are as at be because been before being below ' +
    'between both but by can could did do does doing done down during each else ever few for from ' +
    'further get gets got had has have having he her here hers him his how i if in into is it its ' +
    'itself just let lets like me might more most much must my no nor not now of off on once only or ' +
    'other our ours out over own per please same she should so some still such tell than that the ' +
    'their theirs them then there these they this those through to too under until up upon us very ' +
    'was we were what whats when whens where which while who whom whose why will with would yet you ' +
    'your yours s t d ll re ve m'
  ).split(' '),
);

const IRREGULAR: Record<string, string> = { built: 'build', ran: 'run', went: 'go', began: 'begin', begun: 'begin' };

/** a deliberately small stemmer: plurals, -ing, -ed, a final e, then the first six letters. */
export function stem(word: string): string {
  let w = IRREGULAR[word] ?? word;
  if (/\d/.test(w)) return w;
  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (/(ss|x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) w = w.slice(0, -1);
  if (w.endsWith('ing') && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith('ed') && w.length > 4) w = w.slice(0, -2);
  if (/([b-df-hj-km-np-tv-z])\1$/.test(w) && !/(ll|ss|zz)$/.test(w)) w = w.slice(0, -1);
  if (w.endsWith('e') && w.length > 3) w = w.slice(0, -1);
  return w.length > 6 ? w.slice(0, 6) : w;
}

/** the scoring vocabulary of a piece of text. */
export function terms(text: string): string[] {
  const out: string[] = [];
  for (const raw of normalizeText(text).toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || STOPWORDS.has(raw)) continue;
    if (raw.length < 2) continue;
    out.push(stem(raw));
  }
  return out;
}

function counts(list: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of list) map.set(t, (map.get(t) ?? 0) + 1);
  return map;
}

/* ── identifiers ──────────────────────────────────────────────────────── */

/* the strict form, as the roadmap writes them: ARC-nnn, ARC-nnnB, ARC-LR-nnn, ARC-OPT-nnn.
   (examples here are shapes, never real identifiers — a test holds this code to knowing none.) */
const STRICT_ID = /\bARC-(?:([A-Z]{2,8})-)?(\d{3})([A-Z]?)\b/g;

function formatId(category: string | undefined, digits: string, suffix: string | undefined): string {
  return `ARC-${category ? `${category.toUpperCase()}-` : ''}${digits}${(suffix ?? '').toUpperCase()}`;
}

/** identifiers written the way the roadmap writes them. used on the roadmap and on answers. */
export function strictIds(text: string): string[] {
  const found = new Set<string>();
  for (const m of normalizeText(text).replace(/`/g, '').matchAll(STRICT_ID)) {
    found.add(formatId(m[1], m[2], m[3]));
  }
  return [...found];
}

/* a question is typed, not written: "arc 120", "ARC120", "arc-opt 470". a category is only
   believed when the document itself uses it, so "ARC and 1nn" is not an ARC-AND identifier. */
const LOOSE_ID = /\bARC[-\s]?(?:([A-Za-z]{2,8})[-\s]?)?(\d{3})([A-Za-z]?)\b/gi;

/** the question with its identifiers taken out, so "ARC" and "470" do not also score as words. */
export function withoutIds(text: string, categories: Set<string>): string {
  return normalizeText(text)
    .replace(/`/g, '')
    .replace(LOOSE_ID, (whole: string, category?: string) =>
      category && !categories.has(category.toUpperCase()) ? whole : ' ');
}

export function questionIds(text: string, categories: Set<string>): string[] {
  const found = new Set<string>();
  for (const m of normalizeText(text).replace(/`/g, '').matchAll(LOOSE_ID)) {
    const category = m[1]?.toUpperCase();
    if (category && !categories.has(category)) continue;
    const suffix = m[3] && /^[A-Za-z]$/.test(m[3]) ? m[3] : '';
    found.add(formatId(category, m[2], suffix));
  }
  return [...found];
}

const RANGE =
  /\bARC-((?:[A-Z]{2,8}-)?)(\d{3})\b\s*(?:-|through|thru|to|until)\s*(?:ARC-((?:[A-Z]{2,8}-)?))?(\d{3})\b/gi;

/** spans like "ARC-LR-4n0 through ARC-LR-4m0", or "ARC-OPT-4n0-4m0" once dashes are normalised. */
export function idRanges(text: string): IdRange[] {
  const out: IdRange[] = [];
  for (const m of normalizeText(text).replace(/`/g, '').matchAll(RANGE)) {
    const prefix = `ARC-${m[1].toUpperCase()}`;
    const other = m[3] === undefined ? prefix : `ARC-${m[3].toUpperCase()}`;
    if (other !== prefix) continue;
    const lo = Number(m[2]);
    const hi = Number(m[4]);
    if (!(hi > lo)) continue;
    out.push({ prefix, lo, hi, text: m[0] });
  }
  return out;
}

function splitId(id: string): { prefix: string; n: number } | null {
  const m = /^(ARC-(?:[A-Z]{2,8}-)?)(\d{3})$/.exec(id);
  return m ? { prefix: m[1], n: Number(m[2]) } : null;
}

/* ── parsing ──────────────────────────────────────────────────────────── */

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE = /^\s*(```|~~~)/;
const ANCHOR_TITLE =
  /execution position|current (?:state|status|position)|where we are|immediate next|next (?:task|prompt|step)|implementation sequence|roadmap sequence|build order/i;
const REVISED_KEY = /revision date|revised|last updated|updated/i;

function slug(text: string): string {
  return (
    normalizeText(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'section'
  );
}

/** a section larger than this is cited by its subsections instead of whole. */
export const MAX_SECTION_CHARS = 4_500;

type Node = {
  level: number;
  title: string;
  number: string | null;
  lines: string[];
  startLine: number;
  children: Node[];
  parent: Node | null;
};

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const hasText = (text: string) => /[A-Za-z0-9]/.test(text.replace(/^\s*[-*_]{3,}\s*$/gm, ''));
const withoutNumber = (title: string) => title.replace(/^\d+(?:\.\d+)*[.)]?\s+/, '');

function subtreeLines(node: Node): string[] {
  return [...node.lines, ...node.children.flatMap(subtreeLines)];
}

/**
 * cut the document at its headings.
 *
 * a heading and everything under it is one section — "§6 ARC-OPT-nnn — …" with its purpose,
 * capabilities and boundary together, because that is the unit a question is about. only a
 * section longer than MAX_SECTION_CHARS is cut into its subsections, which then cite as
 * "§7 … › Lead supply": the nearest numbered ancestor stays in the label, because "Lead
 * supply" alone says nothing in a list of sources. headings inside fenced code are text.
 */
export async function buildRoadmapIndex(markdown: string): Promise<RoadmapIndex> {
  const source = String(markdown ?? '');
  const sha256 = await sha256Hex(source);
  const lines = source.replace(/\r\n?/g, '\n').split('\n');

  const root: Node = { level: 0, title: 'Preamble', number: null, lines: [], startLine: 1, children: [], parent: null };
  let current = root;
  let fenced = false;

  lines.forEach((line, i) => {
    if (FENCE.test(line)) fenced = !fenced;
    const m = !fenced ? HEADING.exec(line) : null;
    if (!m) {
      current.lines.push(line);
      return;
    }
    const level = m[1].length;
    let parent = current;
    while (parent.level >= level && parent.parent) parent = parent.parent;
    const title = displayInline(m[2]);
    const node: Node = {
      level,
      title,
      number: /^(\d+(?:\.\d+)*)[.)]?\s+\S/.exec(title)?.[1] ?? null,
      lines: [line],
      startLine: i + 1,
      children: [],
      parent,
    };
    parent.children.push(node);
    current = node;
  });

  const sections: RoadmapSection[] = [];
  const seen = new Map<string, number>();

  const labelFor = (node: Node): string => {
    if (node === root) return 'Preamble';
    if (node.number) return `§${node.number} ${withoutNumber(node.title)}`;
    for (let up = node.parent; up && up !== root; up = up.parent) {
      if (up.number) return `§${up.number} ${withoutNumber(up.title)} › ${node.title}`;
    }
    return node.title;
  };

  const push = (node: Node, chunk: string[]) => {
    const text = chunk.join('\n').trim();
    const path: string[] = [];
    for (let up: Node | null = node; up && up !== root; up = up.parent) path.unshift(up.title);
    let id = slug(node === root ? 'preamble' : path.join(' '));
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    if (n > 1) id = `${id}-${n}`;

    const label = labelFor(node);
    const body = node === root ? text : chunk.slice(1).join('\n');
    /* the label's words count as the title's: a subsection of "§6 ARC-OPT-nnn — …" is
       about that identifier even when its own text never says so. */
    const titleTerms = counts(terms(label));
    const bodyTerms = counts(terms(body));
    sections.push({
      id,
      title: node.title,
      label,
      level: node.level,
      text,
      startLine: node.startLine,
      endLine: node.startLine + chunk.length - 1,
      anchor: false,
      empty: false,
      ids: [...new Set([...strictIds(label), ...strictIds(text)])],
      ranges: idRanges(text),
      titleTerms,
      bodyTerms,
      length: [...titleTerms.values(), ...bodyTerms.values()].reduce((a, b) => a + b, 0),
    });
  };

  const emit = (node: Node) => {
    const whole = subtreeLines(node);
    if (node !== root && (node.children.length === 0 || whole.join('\n').length <= MAX_SECTION_CHARS)) {
      if (hasText(whole.slice(1).join('\n'))) push(node, whole);
      return;
    }
    if (hasText(node === root ? node.lines.join('\n') : node.lines.slice(1).join('\n'))) push(node, node.lines);
    for (const child of node.children) emit(child);
  };
  emit(root);

  const documentTitle = root.children.find((n) => n.level === 1 && !n.number)?.title ?? null;

  /* the current position: the document's opening section, and anything titled as the
     position, the next task or the sequence. */
  sections.forEach((s, i) => {
    if (i === 0 || ANCHOR_TITLE.test(s.title)) s.anchor = true;
  });

  const df = new Map<string, number>();
  for (const s of sections) {
    for (const t of new Set([...s.titleTerms.keys(), ...s.bodyTerms.keys()])) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const ids = new Set(sections.flatMap((s) => s.ids));
  const categories = new Set<string>();
  for (const id of ids) {
    const m = /^ARC-([A-Z]{2,8})-\d{3}/.exec(id);
    if (m) categories.add(m[1]);
  }

  return {
    sha256,
    title: documentTitle,
    revised: revisedDate(sections[0]?.text ?? ''),
    sections,
    ids,
    categories,
    df,
    avgLength: sections.length ? sections.reduce((a, s) => a + s.length, 0) / sections.length : 1,
  };
}

/** "**Roadmap revision date:** September 23, 2026" → "September 23, 2026". */
function revisedDate(headerText: string): string | null {
  for (const line of headerText.split('\n')) {
    const m = /^\s*(?:[-*]\s+)?\*\*([^*]+?)\*\*\s*:?\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1].replace(/:\s*$/, '');
    if (REVISED_KEY.test(key)) return plainInline(m[2]) || null;
  }
  return null;
}

/* ── retrieval ────────────────────────────────────────────────────────── */

export const RETRIEVAL_LIMITS = {
  /** retrieved sections, on top of the anchors */
  maxSections: 5,
  /** characters of retrieved excerpt text, on top of the anchors */
  maxChars: 12_000,
  /** characters of anchor text before the lowest-scoring anchors are dropped */
  maxAnchorChars: 9_000,
  /** a section scoring under this share of the best one is noise */
  relativeFloor: 0.2,
};

const K1 = 1.2;
const B = 0.75;
const TITLE_WEIGHT = 2.5;

function bm25(index: RoadmapIndex, section: RoadmapSection, query: Map<string, number>): number {
  const N = index.sections.length;
  let score = 0;
  for (const [term, weight] of query) {
    const tf = (section.bodyTerms.get(term) ?? 0) + TITLE_WEIGHT * (section.titleTerms.get(term) ?? 0);
    if (!tf) continue;
    const df = index.df.get(term) ?? 0;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    score += weight * idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * section.length) / index.avgLength)));
  }
  return score;
}

export type RetrieveOptions = {
  /** the operator's earlier questions, newest last. they steer retrieval, lightly. */
  previousQuestions?: string[];
};

/**
 * the excerpts one question is answered from: the anchors, then the best-scoring sections.
 *
 * identifiers dominate. a question naming an identifier gets the section titled with it
 * whatever else it says; "ARC-OPT-4n0 through ARC-OPT-4m0" also gets the identifiers the
 * roadmap has between them; an identifier the roadmap never names is reported back, with the
 * range it falls inside when there is one, so the model is told what is missing rather than
 * left to guess.
 */
export function retrieve(index: RoadmapIndex, question: string, options: RetrieveOptions = {}): Retrieval {
  const query = new Map<string, number>();
  const ownTerms = terms(withoutIds(question, index.categories));
  for (const t of ownTerms) query.set(t, (query.get(t) ?? 0) + 1);
  const previous = (options.previousQuestions ?? []).slice(-2);
  for (const q of previous) {
    for (const t of terms(withoutIds(q, index.categories))) query.set(t, (query.get(t) ?? 0) + 0.35);
  }

  const asked = questionIds(question, index.categories);
  for (const q of previous) for (const id of questionIds(q, index.categories)) if (!asked.includes(id)) asked.push(id);

  /* "460 through 480": everything the roadmap itself names in between. */
  const expanded = new Set<string>();
  for (const r of idRanges(question)) {
    for (const id of index.ids) {
      const s = splitId(id);
      if (s && s.prefix === r.prefix && s.n > r.lo && s.n < r.hi) expanded.add(id);
    }
  }

  const unknownIds: string[] = [];
  const rangedIds: { id: string; range: IdRange }[] = [];
  for (const id of asked) {
    if (index.ids.has(id)) continue;
    const s = splitId(id);
    const range = s
      ? index.sections.flatMap((sec) => sec.ranges).find((r) => r.prefix === s.prefix && s.n >= r.lo && s.n <= r.hi)
      : undefined;
    if (range) rangedIds.push({ id, range });
    else unknownIds.push(id);
  }

  /* "the optimization prompts": a word that spells out one of the document's own identifier
     categories (OPT, PILOT, …) points at every identifier in it, more softly than naming one. */
  const questionTerms = [...query.keys()];
  const categoryIds = new Set<string>();
  for (const category of index.categories) {
    const c = category.toLowerCase();
    if (!questionTerms.some((t) => t === c || (c.length >= 3 && t.startsWith(c)))) continue;
    for (const id of index.ids) if (id.startsWith(`ARC-${category}-`)) categoryIds.add(id);
  }

  /* an identifier every section mentions says little about which one answers; a rare one
     says a lot. */
  const N = index.sections.length;
  const idWeight = (id: string) => {
    const df = index.sections.filter((s) => s.ids.includes(id)).length;
    return Math.log(1 + N / Math.max(df, 1));
  };
  const weights = new Map<string, number>();
  for (const id of [...asked, ...expanded, ...categoryIds]) weights.set(id, idWeight(id));

  const scored = index.sections
    .filter((s) => !s.empty)
    .map((section) => {
      let score = bm25(index, section, query);
      const titleIds = strictIds(section.label);
      const add = (id: string, title: number, body: number) => {
        if (section.ids.includes(id)) score += (titleIds.includes(id) ? title : body) * (weights.get(id) ?? 1);
      };
      /* a section titled with the identifier is its definition; one that lists it with
         others is a mention. the definition wins even against a list of all of them. */
      for (const id of asked) add(id, 16, 3);
      for (const id of expanded) if (!asked.includes(id)) add(id, 12, 2);
      for (const id of categoryIds) if (!asked.includes(id) && !expanded.has(id)) add(id, 3, 0.6);
      for (const { range } of rangedIds) {
        if (section.ranges.some((r) => r.prefix === range.prefix && r.lo === range.lo && r.hi === range.hi)) score += 6;
      }
      return { section, score };
    });

  const matched = scored.filter((s) => s.score > 0);
  /* only a question that says something, all of it foreign to the roadmap. "where are we?"
     says nothing a keyword can hold, and is answered from the anchors. */
  const nothingMatched = questionTerms.length > 0 && matched.length === 0 && asked.length === 0;
  /* "what is ARC-nnn?", for one the roadmap never names: every identifier unknown, and
     nothing else asked. */
  const onlyUnknownIds =
    asked.length > 0 && unknownIds.length === asked.length && ownTerms.every((t) => !scored.some((s) => s.section.bodyTerms.has(t) || s.section.titleTerms.has(t)));

  /* anchors first, in document order. if a long roadmap makes them outgrow their budget,
     the ones the question touches stay. */
  let anchors = scored.filter((s) => s.section.anchor);
  let anchorChars = anchors.reduce((a, s) => a + s.section.text.length, 0);
  if (anchorChars > RETRIEVAL_LIMITS.maxAnchorChars) {
    const keep = [...anchors].sort((a, b) => b.score - a.score || a.section.startLine - b.section.startLine);
    const kept: typeof anchors = [];
    anchorChars = 0;
    for (const a of keep) {
      if (kept.length && anchorChars + a.section.text.length > RETRIEVAL_LIMITS.maxAnchorChars) continue;
      kept.push(a);
      anchorChars += a.section.text.length;
    }
    anchors = kept.sort((a, b) => a.section.startLine - b.section.startLine);
  }

  const ranked = scored
    .filter((s) => !s.section.anchor && s.score > 0)
    .sort((a, b) => b.score - a.score || a.section.startLine - b.section.startLine);
  const top = ranked[0]?.score ?? 0;
  const chosen: typeof ranked = [];
  let chars = 0;
  for (const candidate of ranked) {
    if (chosen.length >= RETRIEVAL_LIMITS.maxSections) break;
    const hitsId = asked.some((id) => candidate.section.ids.includes(id)) || [...expanded].some((id) => candidate.section.ids.includes(id));
    if (!hitsId && candidate.score < top * RETRIEVAL_LIMITS.relativeFloor) continue;
    if (chosen.length && chars + candidate.section.text.length > RETRIEVAL_LIMITS.maxChars) continue;
    chosen.push(candidate);
    chars += candidate.section.text.length;
  }

  const excerpts = [...anchors, ...chosen].map((s, i) => ({ ref: `S${i + 1}`, section: s.section, score: s.score }));
  return { excerpts, unknownIds, rangedIds, nothingMatched, onlyUnknownIds };
}
