/**
 * Builds the endless queue.
 *
 * Ranking by model score alone produces exactly the failure this app exists to
 * avoid: an "infinite" playlist that is really the same twenty songs in a loop.
 * The model decides what is good; the constraints in here decide that the queue
 * stays varied. Those are separate jobs, and the constraints do more of the work
 * than people expect.
 *
 * Three mechanisms, in order of how much they matter:
 *
 *  1. Repeat suppression — nothing recently played comes back.
 *  2. Artist capping — at most N tracks by one artist per window.
 *  3. Tag-entropy floor — any window of the queue must span several distinct tags.
 *
 * Epsilon-greedy exploration sits on top, and is exposed to the user as a
 * Discovery slider rather than hidden as a tuning constant.
 */

import { featurize, normalizeTag } from './features.ts';
import type { TasteModel } from './model.ts';
import type { Track, TrackId } from '../types.ts';

/** Sliding window over which the artist cap applies. */
const ARTIST_WINDOW = 20;
const ARTIST_CAP = 2;
/** Any window of this many queued tracks must cover at least MIN_DISTINCT_TAGS. */
const ENTROPY_WINDOW = 20;
const MIN_DISTINCT_TAGS = 5;
/** Exploration halves once the model has seen this many real updates. */
const EXPLORE_DECAY_AFTER = 200;

/** How much one prior play of a tag this session costs a candidate. */
const FATIGUE_WEIGHT = 0.04;
/** Fatigue stops biting past this, so a favourite genre is not banished. */
const FATIGUE_CAP = 0.3;

export interface RankOptions {
  /** How many tracks to return. */
  count: number;
  /** 0..1 from user prefs; the raw epsilon before decay. */
  discovery: number;
  /** Tracks to exclude outright — recently played, disliked, unavailable. */
  exclude?: ReadonlySet<TrackId>;
  /** Time-of-day bucket to score against. */
  bucket: number;
  /** Injectable for deterministic tests and the simulation harness. */
  random?: () => number;
  /**
   * How often each tag has already been served this session. Candidates
   * carrying a well-worn tag are marked down, which is what stops a feed
   * spending an hour on whichever tag the model likes most. Unlike the
   * diversity constraints this is soft and it resets when the app does.
   */
  fatigue?: ReadonlyMap<string, number>;
}

export interface RankedTrack {
  track: Track;
  score: number;
  /** True when this slot was filled by exploration rather than by score. */
  explored: boolean;
}

/** Sum of how worn this track's tags are, bounded so it never dominates. */
function fatigueFor(track: Track, fatigue: ReadonlyMap<string, number> | undefined): number {
  if (!fatigue || fatigue.size === 0) return 0;
  let total = 0;
  for (const tag of tagsOf(track)) total += (fatigue.get(tag) ?? 0) * FATIGUE_WEIGHT;
  return Math.min(total, FATIGUE_CAP);
}

function artistKey(t: Track): string {
  return t.artistId ?? normalizeTag(t.artist);
}

function tagsOf(t: Track): string[] {
  return t.tags.map(normalizeTag).filter((x) => x.length > 0);
}

/**
 * Exploration rate. Starts at the user's discovery setting and halves once the
 * model has enough evidence that its own ranking is worth trusting.
 */
export function exploreRate(discovery: number, modelUpdates: number): number {
  const base = Math.max(0, Math.min(1, discovery));
  return modelUpdates >= EXPLORE_DECAY_AFTER ? base * 0.5 : base;
}

export function buildQueue(
  candidates: readonly Track[],
  model: TasteModel,
  options: RankOptions,
): RankedTrack[] {
  const rand = options.random ?? Math.random;
  const exclude = options.exclude ?? new Set<TrackId>();

  // Score once. Deduplicate by id, since blending several sources can surface
  // the same track twice.
  const seen = new Set<TrackId>();
  const pool: RankedTrack[] = [];
  for (const track of candidates) {
    if (exclude.has(track.id) || seen.has(track.id)) continue;
    seen.add(track.id);
    pool.push({
      track,
      score: model.score(featurize(track, options.bucket)) - fatigueFor(track, options.fatigue),
      explored: false,
    });
  }
  pool.sort((a, b) => b.score - a.score);

  const epsilon = exploreRate(options.discovery, model.n);
  const chosen: RankedTrack[] = [];
  const remaining = pool.slice();

  while (chosen.length < options.count && remaining.length > 0) {
    const eligible = remaining.filter((c) => artistAllowed(c.track, chosen));
    // If the artist cap has starved the pool, relax it rather than return short.
    const usable = eligible.length > 0 ? eligible : remaining;

    let pickIndex: number;
    let explored = false;

    if (rand() < epsilon) {
      pickIndex = indexOfNovelPick(usable, chosen, rand);
      explored = true;
    } else {
      pickIndex = 0; // usable preserves the score ordering
    }

    const pick = usable[pickIndex]!;
    chosen.push({ ...pick, explored });
    remaining.splice(remaining.indexOf(pick), 1);
  }

  return enforceTagEntropy(chosen, remaining);
}

function artistAllowed(track: Track, chosen: readonly RankedTrack[]): boolean {
  const key = artistKey(track);
  const window = chosen.slice(-ARTIST_WINDOW);
  let count = 0;
  for (const c of window) {
    if (artistKey(c.track) === key) count++;
  }
  return count < ARTIST_CAP;
}

/**
 * Exploration should not mean "any random track" — that mostly resurfaces things
 * already well represented. Prefer a candidate carrying a tag the queue has not
 * used yet, which is what actually widens the feed.
 */
function indexOfNovelPick(
  usable: readonly RankedTrack[],
  chosen: readonly RankedTrack[],
  rand: () => number,
): number {
  const used = new Set<string>();
  for (const c of chosen) {
    for (const t of tagsOf(c.track)) used.add(t);
  }

  const novel: number[] = [];
  for (let i = 0; i < usable.length; i++) {
    const tags = tagsOf(usable[i]!.track);
    if (tags.length === 0) continue;
    if (tags.some((t) => !used.has(t))) novel.push(i);
  }

  const bag = novel.length > 0 ? novel : usable.map((_, i) => i);
  return bag[Math.floor(rand() * bag.length)] ?? 0;
}

/**
 * Last pass: if any window is too tag-monotonous, swap its weakest tracks for
 * leftovers that introduce unseen tags. Swaps come from the tail of the window
 * so the strongest recommendations survive.
 */
function enforceTagEntropy(chosen: RankedTrack[], leftovers: RankedTrack[]): RankedTrack[] {
  if (chosen.length < ENTROPY_WINDOW || leftovers.length === 0) return chosen;

  const spare = leftovers.slice();

  for (let start = 0; start + ENTROPY_WINDOW <= chosen.length; start += ENTROPY_WINDOW) {
    const window = chosen.slice(start, start + ENTROPY_WINDOW);
    const distinct = new Set<string>();
    for (const c of window) {
      for (const t of tagsOf(c.track)) distinct.add(t);
    }
    if (distinct.size >= MIN_DISTINCT_TAGS) continue;

    // Walk the window from the weakest end, replacing until the floor is met.
    for (let offset = ENTROPY_WINDOW - 1; offset >= 0 && distinct.size < MIN_DISTINCT_TAGS; offset--) {
      const replacementIndex = spare.findIndex((s) =>
        tagsOf(s.track).some((t) => !distinct.has(t)),
      );
      if (replacementIndex === -1) break;

      const replacement = spare.splice(replacementIndex, 1)[0]!;
      chosen[start + offset] = { ...replacement, explored: true };
      for (const t of tagsOf(replacement.track)) distinct.add(t);
    }
  }

  return chosen;
}
