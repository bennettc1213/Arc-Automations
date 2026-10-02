/**
 * Where the roadmap assistant's knowledge comes from: files, read at request time.
 *
 * The canonical roadmap is docs/architecture/ARC_IMPLEMENTATION_ROADMAP.md in this repository.
 * The `ops` function reads it from `main` as published (raw.githubusercontent.com), not from a
 * copy bundled into the function, for the same reason the site deploys itself: pushing `main`
 * is the deploy. A roadmap edit that reaches `main` is what the next question is answered from
 * — no function redeploy, no upload, no generated index to keep in step, and nothing derived
 * that could disagree with the file, because the digest reported to the console is computed
 * from the bytes actually read. `createRoadmapCorpus`, below, reads it the same way alongside
 * the supplementary documents listed in corpus.ts, each on its own best-effort schedule.
 *
 * Cached per function instance for `ttlMs` (a minute by default) and revalidated with the
 * ETag after that, so a quiet console costs GitHub one conditional request a minute. GitHub's
 * own CDN can hold a new commit back for a few minutes; the digest in every answer says which
 * version answered.
 *
 * `ARC_ROADMAP_SOURCE_URL` points it anywhere else — in local development, the Vite dev server,
 * which serves the working-tree file as it is saved.
 *
 * Failure is loud and specific. A missing file (404), an empty or oversized one, or one with no
 * sections is an error the console shows; the assistant never answers from nothing. A network
 * failure or a 5xx after a successful load serves the last good copy, marked `stale`.
 */

import { buildRoadmapIndex, type RoadmapIndex } from './markdown-index.ts';
import { combineIndexes, CORPUS_DOCS, type CorpusDoc } from './corpus.ts';

export const ROADMAP_PATH = 'docs/architecture/ARC_IMPLEMENTATION_ROADMAP.md';
export const ROADMAP_REPOSITORY = 'bennettc1213/Arc-Automations';
export const ROADMAP_BRANCH = 'main';
export const DEFAULT_ROADMAP_URL = `https://raw.githubusercontent.com/${ROADMAP_REPOSITORY}/${ROADMAP_BRANCH}/${ROADMAP_PATH}`;
export const DEFAULT_CORPUS_BASE_URL = `https://raw.githubusercontent.com/${ROADMAP_REPOSITORY}/${ROADMAP_BRANCH}`;

/** a roadmap is a few dozen kilobytes. anything near this is not one. */
export const MAX_ROADMAP_BYTES = 512 * 1024;

export type RoadmapSourceErrorCode = 'source_unavailable' | 'source_invalid';

export class RoadmapSourceError extends Error {
  readonly code: RoadmapSourceErrorCode;
  constructor(code: RoadmapSourceErrorCode, message: string) {
    super(message);
    this.name = 'RoadmapSourceError';
    this.code = code;
  }
}

export type LoadedRoadmap = {
  index: RoadmapIndex;
  url: string;
  loadedAt: string;
  stale: boolean;
  /** set only by createRoadmapCorpus: the supplementary documents that loaded and are folded
      into `index`, by key. absent (not empty) for a plain single-document source. */
  supporting?: string[];
};

/** what the console is told about the source. a digest and a date, never the text. */
export type RoadmapSourceMeta = {
  path: string;
  sha256: string;
  short: string;
  revised: string | null;
  title: string | null;
  sections: number;
  loaded_at: string;
  stale: boolean;
  /** the supplementary documents folded in, by key. omitted for a plain single-document source. */
  supporting?: string[];
};

export function sourceMeta(loaded: LoadedRoadmap): RoadmapSourceMeta {
  return {
    path: ROADMAP_PATH,
    sha256: loaded.index.sha256,
    short: loaded.index.sha256.slice(0, 12),
    revised: loaded.index.revised,
    title: loaded.index.title,
    sections: loaded.index.sections.length,
    loaded_at: loaded.loadedAt,
    stale: loaded.stale,
    ...(loaded.supporting ? { supporting: loaded.supporting } : {}),
  };
}

export type RoadmapSource = {
  readonly url: string;
  load(): Promise<LoadedRoadmap>;
};

/** the checks a file must pass before a question is answered from it. */
export async function indexRoadmap(markdown: string): Promise<RoadmapIndex> {
  if (!markdown.trim()) throw new RoadmapSourceError('source_invalid', 'the roadmap file is empty');
  const index = await buildRoadmapIndex(markdown);
  if (index.sections.length < 2) {
    throw new RoadmapSourceError('source_invalid', 'the roadmap file has no sections to answer from');
  }
  return index;
}

export function createRoadmapSource(
  options: {
    url?: string | null;
    fetchImpl?: typeof fetch;
    ttlMs?: number;
    timeoutMs?: number;
    now?: () => number;
  } = {},
): RoadmapSource {
  const url = options.url || DEFAULT_ROADMAP_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const ttlMs = options.ttlMs ?? 60_000;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const now = options.now ?? (() => Date.now());

  let cached: { loaded: LoadedRoadmap; etag: string | null; checkedAt: number } | null = null;

  async function load(): Promise<LoadedRoadmap> {
    if (cached && now() - cached.checkedAt < ttlMs) return cached.loaded;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        signal: controller.signal,
        headers: cached?.etag ? { 'if-none-match': cached.etag } : {},
      });
    } catch {
      if (cached) return keepStale();
      throw new RoadmapSourceError(
        'source_unavailable',
        controller.signal.aborted ? `the roadmap did not load in ${timeoutMs / 1000}s` : 'the roadmap could not be fetched',
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 304 && cached) {
      cached = { ...cached, checkedAt: now(), loaded: { ...cached.loaded, stale: false } };
      return cached.loaded;
    }

    if (!response.ok) {
      /* a 5xx is GitHub having a moment; a 404 is the file being gone, which the last good
         copy must not paper over. */
      if (response.status >= 500 && cached) return keepStale();
      throw new RoadmapSourceError(
        'source_unavailable',
        response.status === 404
          ? `the roadmap file was not found at ${ROADMAP_PATH}`
          : `the roadmap source answered ${response.status}`,
      );
    }

    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_ROADMAP_BYTES) {
      throw new RoadmapSourceError('source_invalid', 'the roadmap file is too large to be the roadmap');
    }
    const markdown = await response.text();
    if (new TextEncoder().encode(markdown).length > MAX_ROADMAP_BYTES) {
      throw new RoadmapSourceError('source_invalid', 'the roadmap file is too large to be the roadmap');
    }

    const index =
      cached && cached.loaded.index.sha256 === (await digestOf(markdown)) ? cached.loaded.index : await indexRoadmap(markdown);
    const loaded: LoadedRoadmap = { index, url, loadedAt: new Date(now()).toISOString(), stale: false };
    cached = { loaded, etag: response.headers.get('etag'), checkedAt: now() };
    return loaded;
  }

  function keepStale(): LoadedRoadmap {
    /* checked again next time rather than after a full ttl: the outage may be over. */
    cached = { ...cached!, loaded: { ...cached!.loaded, stale: true } };
    return cached.loaded;
  }

  return { url, load };
}

/**
 * the roadmap, plus every supplementary document that currently loads. one `RoadmapSource` per
 * document (the exact function above, so the caching, ETag revalidation, timeout and
 * stale-serving already tested for the roadmap apply unchanged to each one), combined with
 * `combineIndexes` after every load.
 *
 * The primary roadmap's failure is this source's failure, exactly as `createRoadmapSource`
 * alone behaves — the console still shows a real error if the roadmap itself cannot be read. A
 * supplementary document's failure is invisible here: `Promise.allSettled` drops it, this
 * question is answered from whichever documents did load, and the next call tries it again on
 * its own schedule. The combine step only re-runs when a digest actually changed, so a steady
 * state costs one recombination, not one per question.
 */
export function createRoadmapCorpus(
  options: {
    url?: string | null;
    docs?: CorpusDoc[];
    baseUrl?: string | null;
    fetchImpl?: typeof fetch;
    ttlMs?: number;
    timeoutMs?: number;
    now?: () => number;
  } = {},
): RoadmapSource {
  const primary = createRoadmapSource(options);
  const docs = options.docs ?? CORPUS_DOCS;
  const base = (options.baseUrl || DEFAULT_CORPUS_BASE_URL).replace(/\/+$/, '');
  const secondary = docs.map((doc) => ({ doc, source: createRoadmapSource({ ...options, url: `${base}/${doc.path}` }) }));

  let combined: { primarySha: string; secondaryShas: string; index: RoadmapIndex } | null = null;

  async function load(): Promise<LoadedRoadmap> {
    const loadedPrimary = await primary.load();

    const settled = await Promise.allSettled(secondary.map((s) => s.source.load()));
    const included: { doc: CorpusDoc; loaded: LoadedRoadmap }[] = [];
    settled.forEach((result, i) => {
      if (result.status === 'fulfilled') included.push({ doc: secondary[i].doc, loaded: result.value });
    });

    const secondaryShas = included.map((i) => i.loaded.index.sha256).join(',');
    if (!combined || combined.primarySha !== loadedPrimary.index.sha256 || combined.secondaryShas !== secondaryShas) {
      const index = await combineIndexes(
        loadedPrimary.index,
        included.map((i) => ({ doc: i.doc, index: i.loaded.index })),
      );
      combined = { primarySha: loadedPrimary.index.sha256, secondaryShas, index };
    }

    return {
      index: combined.index,
      url: loadedPrimary.url,
      loadedAt: loadedPrimary.loadedAt,
      stale: loadedPrimary.stale,
      supporting: included.map((i) => i.doc.key),
    };
  }

  return { url: primary.url, load };
}

async function digestOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
