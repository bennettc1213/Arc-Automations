/**
 * The roadmap, searched: what the assistant shows when no model can answer.
 *
 * No model, no key, no cost. The retrieval that picks a model's excerpts already knows which
 * sections a question is about, so this shows those sections themselves — the passages of each
 * that mention what was asked, in the roadmap's own words, under the section's title. Nothing
 * here writes a sentence. It cannot summarise, connect two sections or reason about them, and it
 * says so in the first line it prints; what it can do is be right, because every word it shows
 * is the file's.
 *
 * It is used when there is no model to ask (no key, or `ARC_ROADMAP_PROVIDER=search` chosen on
 * purpose) and when the model fails (no credit, an outage, a timeout), so the panel still shows
 * the operator something true instead of an error and nothing else. The reason is always
 * printed with it: a failure is never dressed up as an answer.
 *
 * Nothing in here knows what the roadmap says. It knows how roadmaps are shaped — headings,
 * paragraphs, lists, tables — and it treats the current-state sections the way retrieval does.
 *
 * Pure TypeScript, so node's test runner loads it as-is. Types come from answer.ts and are
 * erased; there is no import cycle at run time.
 */

import {
  questionIds,
  retrieve,
  strictIds,
  terms,
  withoutIds,
  type Excerpt,
  type RoadmapIndex,
  type RoadmapSection,
} from './markdown-index.ts';
import type { Citation, HistoryTurn, RoadmapAnswer } from './answer.ts';

export const SEARCH_LIMITS = {
  /** matching sections shown */
  sections: 3,
  /** characters of the best-matching section's passage, and of each other one's */
  bestChars: 800,
  passageChars: 480,
  /** the current-position sections shown beside the matches, and how much of each */
  currentSections: 2,
  currentChars: 360,
  /** matches that are only named, not shown */
  namedMore: 4,
  /** a section scoring under this share of the best one is noise */
  relativeFloor: 0.4,
};

/** why there is no model answer. `chosen` is a deployment that asked for search on purpose. */
export type SearchMode = 'chosen' | 'unconfigured' | 'failed';

const HEADING_LINE = /^#{1,6}[ \t]+/;
const FENCE_LINE = /^\s*(```|~~~)/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

const cellsOf = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())
    .filter(Boolean);

/* the roadmap's Markdown, made readable by a renderer that has no tables or block quotes: a
   table's header becomes a bold line and each row a list item, a separator row goes, a quote
   loses its marker and a line break tag is a space. words are never changed. */
function tidy(lines: string[]): string {
  const out: string[] = [];
  let fenced = false;
  lines.forEach((line, i) => {
    if (FENCE_LINE.test(line)) {
      fenced = !fenced;
      out.push(line);
      return;
    }
    if (fenced) {
      out.push(line);
      return;
    }
    const next = lines[i + 1];
    if (TABLE_ROW.test(line) && next !== undefined && TABLE_RULE.test(next) && next.includes('|')) {
      out.push(`**${cellsOf(line).join(' — ').replace(/\*\*/g, '')}**`);
    } else if (TABLE_RULE.test(line) && (line.includes('|') || /^\s*[-*_]{3,}\s*$/.test(line))) {
      // a separator or a rule: structure, not text
    } else if (TABLE_ROW.test(line)) {
      out.push(`- ${cellsOf(line).join(' — ')}`);
    } else {
      out.push(line.replace(/^\s*>\s?/, '').replace(/<br\s*\/?>/gi, ' '));
    }
  });
  return out.join('\n').trim();
}

/* a section's body as blocks: paragraphs, lists, tables and code, each whole. a sub-heading
   rides with what follows it, and the section's own heading is dropped (its label says it). */
function blocksOf(section: RoadmapSection): string[] {
  const lines = section.text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length && HEADING_LINE.test(lines[0])) lines.shift();

  const raw: string[][] = [];
  let current: string[] = [];
  let fenced = false;
  const flush = () => {
    if (current.some((l) => l.trim())) raw.push(current);
    current = [];
  };
  for (const line of lines) {
    if (FENCE_LINE.test(line)) {
      fenced = !fenced;
      current.push(line);
    } else if (fenced) {
      current.push(line);
    } else if (!line.trim()) {
      flush();
    } else {
      if (HEADING_LINE.test(line)) flush();
      current.push(line);
    }
  }
  flush();

  const merged: string[][] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const heading = raw[i].every((l) => HEADING_LINE.test(l));
    if (heading && i + 1 < raw.length) raw[i + 1] = [...raw[i], ...raw[i + 1]];
    else merged.push(raw[i]);
  }
  return merged.map(tidy).filter((b) => /[A-Za-z0-9]/.test(b));
}

const NUMBERED_LINE = /^(\s*)(\d+)[.)]\s+(.*)$/;

/* a block cut to `room` characters at a line, or failing that at a word — never mid-word, and
   never leaving a code fence open. a long list or table is cut around the line that matches
   the question, not from its top: the eleventh item of a list is not reached by showing the
   first ten. a list that starts part-way keeps its own numbers, because a renderer would
   count it from 1. */
function cut(block: string, room: number, scoreLine?: (line: string) => number): string {
  if (block.length <= room) return block;
  const lines = block.split('\n');
  if (lines.length > 1) {
    let start = 0;
    if (scoreLine && !FENCE_LINE.test(lines[0])) {
      let best = 0;
      lines.forEach((line, i) => {
        const score = scoreLine(line);
        if (score > best) {
          best = score;
          start = Math.max(0, i - 1);
        }
      });
    }
    const keep: string[] = [];
    let used = 0;
    for (let i = start; i < lines.length; i += 1) {
      const line = start > 0 ? lines[i].replace(NUMBERED_LINE, '$1- $2. $3') : lines[i];
      if (keep.length && used + line.length + 1 > room) break;
      keep.push(line);
      used += line.length + 1;
    }
    if (keep.filter((l) => FENCE_LINE.test(l)).length % 2) keep.push('```');
    if (start > 0) keep.unshift('…');
    if (start + keep.length - (start > 0 ? 1 : 0) < lines.length) keep.push('…');
    return keep.join('\n');
  }
  const head = block.slice(0, room);
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('; '));
  const at = sentence > room * 0.5 ? sentence + 1 : head.lastIndexOf(' ');
  return `${head.slice(0, at > 0 ? at : room).trimEnd()}…`;
}

/** the passage of a section worth showing: the blocks that mention the question, in the
    order the roadmap has them, inside a character budget. `lead` shows the opening instead. */
function passage(
  index: RoadmapIndex,
  section: RoadmapSection,
  query: Set<string>,
  ids: string[],
  budget: number,
  lead: boolean,
): string {
  const blocks = blocksOf(section);
  if (!blocks.length) return '';

  const N = index.sections.length;
  const scoreText = (text: string): number => {
    if (lead) return 0;
    const present = new Set(terms(text));
    let score = 0;
    for (const t of query) if (present.has(t)) score += Math.log(1 + N / Math.max(index.df.get(t) ?? 1, 1));
    const found = strictIds(text);
    for (const id of ids) if (found.includes(id)) score += 4;
    return score;
  };
  const scores = blocks.map(scoreText);

  const order = blocks
    .map((_, i) => i)
    .sort((a, b) => (lead ? a - b : scores[b] - scores[a] || a - b))
    .filter((i) => lead || scores[i] > 0);
  if (!order.length) order.push(...blocks.map((_, i) => i));

  const chosen = new Map<number, string>();
  let used = 0;
  for (const i of order) {
    const room = budget - used;
    if (room < 80) break;
    if (blocks[i].length <= room) {
      chosen.set(i, blocks[i]);
      used += blocks[i].length + 2;
    } else if (!chosen.size) {
      chosen.set(i, cut(blocks[i], room, scoreText));
      used = budget;
    } else if (lead) {
      /* an opening is read from the top: skipping a block that does not fit and showing the
         ones after it would tear the passage apart. */
      break;
    }
  }
  /* the opening usually says what the section is for; keep it beside the match if it fits. */
  if (!lead && !chosen.has(0) && blocks[0].length <= budget - used) {
    chosen.set(0, blocks[0]);
    used += blocks[0].length + 2;
  }
  /* "The next prompt is:" is nothing without what follows it. bring the follow-up along, cut
     to what is left, or drop the lead-in when there is no room and something else is shown. */
  for (const i of [...chosen.keys()].sort((a, b) => a - b)) {
    if (!/:\s*$/.test(blocks[i]) || chosen.has(i + 1) || i + 1 >= blocks.length) continue;
    const room = budget - used;
    if (room < 120 && chosen.size > 1) {
      chosen.delete(i);
      continue;
    }
    const follow = cut(blocks[i + 1], Math.max(room, 120), scoreText);
    chosen.set(i + 1, follow);
    used += follow.length + 2;
  }

  const shown = [...chosen.keys()].sort((a, b) => a - b);
  const parts: string[] = [];
  shown.forEach((i, n) => {
    if (n > 0 && i !== shown[n - 1] + 1) parts.push('…');
    parts.push(chosen.get(i) as string);
  });
  return parts.join('\n\n');
}

const toCitation = (e: Excerpt): Citation => ({ ref: e.ref, label: e.section.label, section_id: e.section.id });

function introFor(mode: SearchMode, why: string | null): string {
  const reason = (why ?? '').replace(/[.\s]+$/, '');
  if (mode === 'chosen') {
    return "**Search mode:** the roadmap's own passages for your question. No AI model is involved, so nothing is summarized.";
  }
  if (mode === 'failed') {
    return `**The AI model couldn't answer${reason ? ` (${reason})` : ''},** so these are the roadmap's own passages for your question instead. Nothing is summarized.`;
  }
  return `**No AI model is connected,** so these are the roadmap's own passages for your question, not a written answer.${reason ? ` (${reason}.)` : ''}`;
}

/**
 * the roadmap's own passages for one question, shaped as an answer the panel already renders:
 * Markdown text, and the sections it came from as citations. Its status is `excerpts`, which
 * is neither an answer nor a "not in the roadmap" — it makes no claim about either.
 */
export function searchRoadmap(input: {
  index: RoadmapIndex;
  question: string;
  history?: HistoryTurn[];
  mode: SearchMode;
  /** the operator-facing reason there is no model answer, already stripped of any secret */
  why?: string | null;
}): RoadmapAnswer {
  const { index } = input;
  const question = input.question.trim();
  const history = input.history ?? [];
  const retrieval = retrieve(index, question, {
    previousQuestions: history.filter((t) => t.role === 'user').map((t) => t.content),
  });
  const asked = questionIds(question, index.categories);
  const query = new Set(terms(withoutIds(question, index.categories)));

  const ranked = retrieval.excerpts
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score || a.section.startLine - b.section.startLine);
  const top = ranked[0]?.score ?? 0;
  const matches = ranked.filter((e) => e.score >= top * SEARCH_LIMITS.relativeFloor).slice(0, SEARCH_LIMITS.sections);

  /* where the roadmap says things stand: shown with a question that names no prompt, which is
     when "where are we" is what is being asked, and instead of matches when there are none. the
     document's own opening section is a title block, not a position, so it comes last. */
  const opening = index.sections[0];
  const anchors = retrieval.excerpts.filter((e) => e.section.anchor && !matches.includes(e));
  const positions = [...anchors.filter((e) => e.section !== opening), ...anchors.filter((e) => e.section === opening)];
  const showPosition = asked.length === 0 || matches.length === 0;
  const position = showPosition
    ? positions.slice(0, matches.length ? SEARCH_LIMITS.currentSections : SEARCH_LIMITS.currentSections + 1)
    : [];
  position.sort((a, b) => a.section.startLine - b.section.startLine);

  const parts: string[] = [introFor(input.mode, input.why ?? null)];

  for (const id of retrieval.unknownIds) parts.push(`The roadmap does not mention ${id}.`);
  for (const { id, range } of retrieval.rangedIds) {
    parts.push(`${id} is not named on its own. The roadmap mentions the span "${range.text}".`);
  }
  if (!matches.length) parts.push('No section of the roadmap matches those words.');

  const shown: Excerpt[] = [];
  matches.forEach((e, i) => {
    const text = passage(index, e.section, query, asked, i === 0 ? SEARCH_LIMITS.bestChars : SEARCH_LIMITS.passageChars, false);
    if (!text) return;
    parts.push(`**${e.section.label}**`, text);
    shown.push(e);
  });

  if (position.length) {
    parts.push(matches.length ? '**Where the roadmap says things stand**' : '**Where the roadmap says things stand, in case it helps**');
    for (const e of position) {
      const text = passage(index, e.section, query, asked, matches.length ? SEARCH_LIMITS.currentChars : SEARCH_LIMITS.passageChars, true);
      if (!text) continue;
      parts.push(`**${e.section.label}**`, text);
      shown.push(e);
    }
  }

  const rest = ranked.filter((e) => !shown.includes(e)).map((e) => e.section.label);
  if (rest.length) {
    const named = rest.slice(0, SEARCH_LIMITS.namedMore).join('; ');
    parts.push(`Also matched: ${named}${rest.length > SEARCH_LIMITS.namedMore ? `; and ${rest.length - SEARCH_LIMITS.namedMore} more` : ''}.`);
  }

  return {
    status: 'excerpts',
    answer: parts.join('\n\n'),
    citations: shown.map(toCitation),
    missing: null,
    withheld: null,
    model: null,
    ms: 0,
    sections: shown.map((e) => e.section.id),
  };
}
