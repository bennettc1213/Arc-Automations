/**
 * The roadmap assistant's knowledge, widened past the one canonical file.
 *
 * The roadmap (`ROADMAP_PATH` in source.ts) stays the primary document: it alone contributes
 * the current-position sections sent with every question, its sections keep their own labels
 * and ids exactly as before, and its own failure is still the assistant's failure. The documents
 * here are supplementary — the architecture docs that describe how the system that roadmap
 * describes actually works — so an operator can ask "how does X work" and not only "what's
 * next". Each is combined in by `combineIndexes`, never a roadmap fact written into this file:
 * the list below is which documents exist, not what they say.
 *
 * A document here is best-effort. One that 404s (not pushed yet, renamed, deleted) or times out
 * simply contributes nothing to that question — the primary roadmap still answers on its own,
 * and the panel is never told the assistant is broken over an optional document. See
 * `createRoadmapCorpus` in source.ts, which fetches each of these the same way it fetches the
 * roadmap and drops the ones that fail.
 */

import { terms, type RoadmapIndex, type RoadmapSection } from './markdown-index.ts';

export type CorpusDoc = { key: string; path: string };

/** every other document that gives the assistant fuller context on what ARC is and where it is
    headed: `CLAUDE.md` (the project's own architecture summary), the architecture docs under
    `docs/architecture/`, and the master implementation-roadmap handoffs at the repository root
    (`ARC_MASTER_ROADMAP_*`). Each is read from `main` like the roadmap, at whatever path it
    lives at — root-level paths work the same as `docs/architecture/` ones. To add one, add its
    path here — nothing else changes. A doc not yet pushed to `main` 404s and contributes
    nothing until it is, same as any other document here. */
export const CORPUS_DOCS: CorpusDoc[] = [
  { key: 'overview', path: 'CLAUDE.md' },
  { key: 'assistant', path: 'docs/architecture/ARC_ROADMAP_ASSISTANT.md' },
  { key: 'lead-recovery', path: 'docs/architecture/ARC_LEAD_RECOVERY_SAFETY_AND_PINNING.md' },
  { key: 'registries', path: 'docs/architecture/ARC_MODULE_AND_CONNECTOR_REGISTRIES.md' },
  { key: 'lifecycle', path: 'docs/architecture/ARC_TENANT_MODULE_LIFECYCLE.md' },
  { key: 'config', path: 'docs/architecture/ARC_VERSIONED_TENANT_CONFIGURATION_ENGINE.md' },
  { key: 'connections', path: 'docs/architecture/ARC_PROVIDER_CONNECTIONS_AND_OAUTH.md' },
  { key: 'crm-core', path: 'docs/architecture/ARC_CRM_CORE.md' },
  { key: 'native-intake', path: 'docs/architecture/ARC_NATIVE_INTAKE.md' },
  { key: 'crm-workspace', path: 'docs/architecture/ARC_CRM_WORKSPACE.md' },
  { key: 'communications', path: 'docs/architecture/ARC_COMMUNICATIONS_HUB.md' },
  { key: 'booking', path: 'docs/architecture/ARC_BOOKING.md' },
  { key: 'onboarding', path: 'docs/architecture/ARC_ONBOARDING.md' },
  { key: 'proof_ledger', path: 'docs/architecture/ARC_PROOF_LEDGER.md' },
  { key: 'n8n-boundary', path: 'docs/architecture/ARC_N8N_EXECUTION_BOUNDARY_ADR.md' },
  { key: 'n8n-audit', path: 'docs/architecture/ARC_N8N_REPOSITORY_AUDIT.md' },
  { key: 'master-roadmap', path: 'ARC_MASTER_ROADMAP_FROM_ARC_200.md' },
  { key: 'master-roadmap-crm', path: 'ARC_MASTER_ROADMAP_EXPANDED_NATIVE_CRM_FROM_ARC_200.md' },
];

function countsOf(words: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const w of words) map.set(w, (map.get(w) ?? 0) + 1);
  return map;
}

/** a secondary document's sections, tagged with where they came from: namespaced ids so they
    cannot collide with the primary roadmap's, a label prefixed with the document's own title so
    a citation reads "ARC Roadmap Assistant › Configuration" rather than a bare "Configuration"
    that could be any document's, and never an anchor — "the current position" is the roadmap's
    question to answer, not a supplementary document's opening paragraph. */
function taggedSections(doc: CorpusDoc, index: RoadmapIndex): RoadmapSection[] {
  const title = index.title ?? doc.key;
  const titleWords = countsOf(terms(title));
  return index.sections.map((s) => {
    const titleTerms = new Map(s.titleTerms);
    for (const [term, n] of titleWords) titleTerms.set(term, (titleTerms.get(term) ?? 0) + n);
    /* a document short enough to stay one section (under buildRoadmapIndex's 4,500-character
       split threshold) has that section's own label equal to the document's title already —
       prefixing it again would cite "ARC Roadmap Assistant › ARC Roadmap Assistant". */
    return {
      ...s,
      id: `${doc.key}:${s.id}`,
      label: s.label === title ? s.label : `${title} › ${s.label}`,
      anchor: false,
      doc: { key: doc.key, title: index.title },
      titleTerms,
    };
  });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * the primary roadmap's index, with zero or more supplementary documents folded in: their
 * sections searchable and citable alongside the roadmap's, scored by the same BM25 recomputed
 * over the combined set so a document's own vocabulary doesn't skew relevance against it.
 *
 * The roadmap's own sections are returned exactly as `buildRoadmapIndex` made them — same ids,
 * same labels, same anchors — so every existing citation, test and golden question still holds.
 * `title`, `revised` and the current-position anchors are the roadmap's, because they answer
 * "what is this document" and "where are we", both of which are the roadmap's questions, not a
 * supplementary document's.
 */
export async function combineIndexes(primary: RoadmapIndex, others: { doc: CorpusDoc; index: RoadmapIndex }[]): Promise<RoadmapIndex> {
  const sections = [...primary.sections, ...others.flatMap(({ doc, index }) => taggedSections(doc, index))];

  const df = new Map<string, number>();
  for (const s of sections) {
    for (const t of new Set([...s.titleTerms.keys(), ...s.bodyTerms.keys()])) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const ids = new Set(primary.ids);
  const categories = new Set(primary.categories);
  for (const { index } of others) {
    for (const id of index.ids) ids.add(id);
    for (const c of index.categories) categories.add(c);
  }

  const sha256 = await sha256Hex([primary.sha256, ...others.map(({ index }) => index.sha256)].join(','));

  return {
    sha256,
    title: primary.title,
    revised: primary.revised,
    sections,
    ids,
    categories,
    df,
    avgLength: sections.length ? sections.reduce((a, s) => a + s.length, 0) / sections.length : 1,
  };
}
