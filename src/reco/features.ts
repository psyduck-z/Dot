/**
 * Turns a track plus a listening context into a sparse feature vector.
 *
 * Design notes:
 *
 * - Tags are weighted highest. On most catalogues the formal `genre` field is a
 *   coarse fixed enum that buries what the music actually is — a drift phonk track
 *   routinely comes back labelled "Electronic", "Hip-Hop/Rap" or "Experimental",
 *   while the useful descriptor sits in free-text tags. Modelling on genre alone
 *   would throw away almost all of the signal.
 *
 * - Features are hashed into a fixed-width space rather than kept in a growing
 *   dictionary. That keeps the model a fixed-size Float32Array, which matters both
 *   for weak hardware and for storing it reliably.
 *
 * - Time-of-day is included as buckets *and* as interactions with the top tags,
 *   which gives contextual behaviour without a separate contextual model.
 */

import type { Track } from '../types.ts';

/** Power of two so the hash can mask instead of divide. */
export const FEATURE_DIM = 1024;
const MASK = FEATURE_DIM - 1;

export interface SparseVec {
  idx: number[];
  val: number[];
}

/** FNV-1a. Small, fast, no dependencies, good enough for feature hashing. */
export function hashKey(s: string): number {
  return hash(s);
}

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) & MASK;
}

export function normalizeTag(raw: string): string {
  return raw.toLowerCase().trim().replace(/[\s_]+/g, '');
}

/** 0 night, 1 morning, 2 afternoon, 3 evening. */
export function contextBucket(date: Date = new Date()): number {
  const h = date.getHours();
  if (h < 6) return 0;
  if (h < 12) return 1;
  if (h < 18) return 2;
  return 3;
}

const WEIGHT = {
  flow: 0.45,
  kind: 0.7,
  kindTag: 0.5,
  tag: 1.0,
  genre: 0.6,
  mood: 0.5,
  artist: 0.8,
  duration: 0.3,
  popularity: 0.2,
  context: 0.4,
  tagContext: 0.5,
  bias: 1.0,
} as const;

/** Coarse duration buckets. A 45s loop and a 6min mix are different products. */
function durationBucket(seconds: number): string {
  if (!seconds) return 'unknown';
  if (seconds < 90) return 'short';
  if (seconds < 240) return 'normal';
  if (seconds < 420) return 'long';
  return 'verylong';
}

/**
 * Popularity is deliberately crushed to three buckets. On small catalogues the
 * raw play counts are in the low hundreds, where the number is mostly noise and
 * using it directly would just bias everything toward whatever charted.
 */
function popularityBucket(playCount: number | undefined): string {
  if (playCount === undefined) return 'unknown';
  if (playCount < 100) return 'low';
  if (playCount < 5000) return 'mid';
  return 'high';
}

/** How many of a track's tags also get a time-of-day interaction feature. */
const TAG_CONTEXT_LIMIT = 8;

/**
 * `previousTags` are the tags of the track that just played.
 *
 * Music is sequential in a way a feed of clips is not: the same song can be
 * right after one track and wrong after another, and a model that sees tracks
 * only in isolation cannot express that. Pairing the outgoing tags with the
 * incoming ones lets it learn transitions — that heavy follows heavy, or where
 * an evening tends to drift — rather than only which tracks are good on
 * average.
 */
export function featurize(track: Track, bucket: number, previousTags: string[] = []): SparseVec {
  const acc = new Map<number, number>();

  const add = (key: string, weight: number): void => {
    const i = hash(key);
    acc.set(i, (acc.get(i) ?? 0) + weight);
  };

  add('__bias', WEIGHT.bias);

  const tags = track.tags.map(normalizeTag).filter((t) => t.length > 0);
  for (const tag of tags) {
    add('tag:' + tag, WEIGHT.tag);
  }

  if (track.genre) add('genre:' + normalizeTag(track.genre), WEIGHT.genre);
  if (track.mood) add('mood:' + normalizeTag(track.mood), WEIGHT.mood);
  if (track.artistId) add('artist:' + track.artistId, WEIGHT.artist);
  else if (track.artist) add('artist:' + normalizeTag(track.artist), WEIGHT.artist);

  // Surface is a feature rather than a separate model. Three models would each
  // see a third of the data; one model with a surface feature lets taste carry
  // across Music, Shorts and Videos while still learning that a tag can land
  // differently on each — short phonk edits and long ambient videos are not the
  // same preference.
  if (track.kind) {
    add('kind:' + track.kind, WEIGHT.kind);
    for (const tag of tags.slice(0, TAG_CONTEXT_LIMIT)) {
      add('kindtag:' + track.kind + ':' + tag, WEIGHT.kindTag);
    }
  }

  add('dur:' + durationBucket(track.duration), WEIGHT.duration);
  add('pop:' + popularityBucket(track.playCount), WEIGHT.popularity);
  add('ctx:' + bucket, WEIGHT.context);

  for (const tag of tags.slice(0, TAG_CONTEXT_LIMIT)) {
    add('tagctx:' + tag + ':' + bucket, WEIGHT.tagContext);
  }

  // Three by three, deliberately. Every extra pair is another sparse feature
  // competing for the same evidence, and transitions refine taste rather than
  // replace it.
  const previous = previousTags.map(normalizeTag).filter((t) => t.length > 0).slice(0, 3);
  for (const from of previous) {
    for (const to of tags.slice(0, 3)) {
      add('flow:' + from + '>' + to, WEIGHT.flow);
    }
  }

  return l2normalize(acc);
}

/**
 * L2 normalization keeps the update magnitude comparable between a track tagged
 * once and a track tagged twenty times. Without it, heavily tagged tracks would
 * dominate learning purely by being verbose.
 */
function l2normalize(acc: Map<number, number>): SparseVec {
  const idx: number[] = [];
  const val: number[] = [];

  let sumSquares = 0;
  for (const v of acc.values()) sumSquares += v * v;
  const norm = sumSquares > 0 ? Math.sqrt(sumSquares) : 1;

  for (const [i, v] of acc) {
    idx.push(i);
    val.push(v / norm);
  }
  return { idx, val };
}

/** A single named feature as its own unit vector, for cold-start seeding. */
export function unitFeature(key: string): SparseVec {
  return { idx: [hash(key)], val: [1] };
}

export function seedFeatureKey(kind: 'tag' | 'artist', value: string): string {
  return kind === 'tag' ? 'tag:' + normalizeTag(value) : 'artist:' + normalizeTag(value);
}
