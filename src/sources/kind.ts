/**
 * Sorts a track into Music, Shorts or Videos.
 *
 * This runs locally on candidates the app already has, which is the whole
 * reason three tabs cost no more quota than one: the app fetches a single pool
 * and decides what belongs where without asking the API anything extra.
 *
 * Shorts are the awkward case. YouTube has no Shorts API — a Short is just an
 * ordinary video that happens to be vertical and brief, so it has to be
 * inferred. Two signals do it well:
 *
 *   - duration at or under three minutes (the current Shorts ceiling)
 *   - a portrait embed, which the API reports in the `player` part
 *
 * Music is easier, because YouTube categorises it: category 10 is Music, and
 * "Artist - Topic" channels are auto-generated for released tracks. Keyword
 * scoring is only the fallback for music uploaded under another category,
 * which is common for music videos filed under Entertainment.
 */

import { musicScore, type FilterInput } from './filter.ts';

export type TrackKind = 'music' | 'short' | 'video';

/** YouTube's Music category. */
const MUSIC_CATEGORY_ID = '10';

/** The current Shorts ceiling. It was 60s until 2024. */
const SHORT_MAX_SECONDS = 180;

/** Above this, keyword evidence alone is enough to call something music. */
const MUSIC_SCORE_THRESHOLD = 4;

export interface KindInput extends FilterInput {
  duration: number;
  /** Embed dimensions from the API's `player` part, when available. */
  aspect?: { width: number; height: number };
  /** The source's own category id, if it has one. */
  categoryId?: string;
}

/**
 * Uploaders tag Shorts by convention, and it is the only Shorts signal that
 * survives when the API returns no usable dimensions — which is most of the
 * time unless the request asks for them explicitly.
 */
export function hasShortsMarker(input: KindInput): boolean {
  const text = (input.title + ' ' + (input.tags ?? []).join(' ')).toLowerCase();
  return text.indexOf('#shorts') >= 0 || text.indexOf('#short ') >= 0 ||
    (input.tags ?? []).some((t) => t.toLowerCase().replace(/^#/, '') === 'shorts');
}

export function isPortrait(aspect: { width: number; height: number } | undefined): boolean {
  if (!aspect || aspect.width <= 0 || aspect.height <= 0) return false;
  return aspect.height > aspect.width;
}

export function classifyKind(input: KindInput): TrackKind {
  // Shorts first: a vertical 45-second music clip is a Short, not a track.
  //
  // Duration alone is not enough — plenty of songs run under three minutes —
  // so it has to be paired with evidence of the format: a portrait embed, or
  // the #shorts tag uploaders use by convention. Relying on orientation alone
  // was why the Shorts tab came up empty: the API only reports dimensions when
  // the request asks for them.
  if (
    input.duration > 0 &&
    input.duration <= SHORT_MAX_SECONDS &&
    (isPortrait(input.aspect) || hasShortsMarker(input))
  ) {
    return 'short';
  }

  if (input.categoryId === MUSIC_CATEGORY_ID) return 'music';
  // Auto-generated channels only ever carry properly released music.
  if (/\s-\s*topic\s*$/.test(input.artist.toLowerCase())) return 'music';
  if (musicScore(input) >= MUSIC_SCORE_THRESHOLD) return 'music';

  return 'video';
}

/**
 * Parses the width and height out of the API's embed HTML.
 *
 * `videos.list` with `part=player` returns an iframe snippet whose dimensions
 * follow the source video's orientation, which is the cheapest way to know a
 * video is vertical. Requesting the extra part is free — quota is charged per
 * call, not per part.
 */
export function parseEmbedAspect(embedHtml: string | undefined): { width: number; height: number } | undefined {
  if (!embedHtml) return undefined;
  const width = /width="(\d+)"/.exec(embedHtml);
  const height = /height="(\d+)"/.exec(embedHtml);
  if (!width?.[1] || !height?.[1]) return undefined;
  return { width: Number(width[1]), height: Number(height[1]) };
}
