/**
 * Simulation harness for the recommender.
 *
 * A synthetic listener with fixed, hidden tag preferences reacts to whatever the
 * queue serves. The model never sees those preferences — only skips and
 * completions — and has to recover them.
 *
 * This exists because "the algorithm feels good" is not a claim anyone can check.
 * It reports two numbers that pull against each other, and both have to hold:
 *
 *   - Satisfaction: the listener's true probability of liking what was served.
 *     Rising means the model is learning.
 *   - Novelty: distinct tags served in the recent window. Staying high means it
 *     is not collapsing into a filter bubble.
 *
 * Optimising either one alone is trivial. Both at once is the actual problem.
 */

import { TasteModel, labelFor } from '../../src/reco/model.ts';
import { buildQueue } from '../../src/reco/queue.ts';
import { featurize } from '../../src/reco/features.ts';
import type { PlayEvent, Track } from '../../src/types.ts';

/** Deterministic RNG so runs are reproducible and CI can assert on them. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAG_VOCAB = [
  'phonk', 'driftphonk', 'memphis', 'trap', 'bassboost',
  'lofi', 'chillhop', 'ambient', 'study', 'piano',
  'techno', 'house', 'dnb', 'breakcore', 'hyperpop',
  'rock', 'metal', 'punk', 'indie', 'shoegaze',
  'jazz', 'soul', 'funk', 'disco', 'rnb',
  'classical', 'orchestral', 'folk', 'country', 'reggae',
];

/**
 * Transitions the listener secretly cares about, on top of the tag preferences
 * below. A track is more welcome after some things than others, which is the
 * whole point of the flow features — a model scoring tracks in isolation
 * cannot represent this no matter how much data it sees.
 */
const HIDDEN_TRANSITIONS: Record<string, number> = {
  'phonk>driftphonk': 1.6,
  'driftphonk>phonk': 1.6,
  'phonk>memphis': 1.2,
  'ambient>lofi': 1.2,
  'lofi>ambient': 1.2,
  // Jarring: loud straight after quiet.
  'ambient>breakcore': -1.8,
  'lofi>phonk': -1.5,
  'piano>bassboost': -1.8,
};

/** What the listener secretly likes. The model must infer this from behaviour. */
const HIDDEN_PREFS: Record<string, number> = {
  phonk: 2.2, driftphonk: 2.0, memphis: 1.4, bassboost: 1.0, trap: 0.9,
  funk: 0.8, breakcore: 0.5, hyperpop: 0.3,
  techno: 0.1, dnb: 0.1,
  lofi: -0.4, ambient: -0.6, study: -0.7, piano: -0.8,
  classical: -1.4, orchestral: -1.3, country: -1.5, folk: -1.0,
};

function makeCatalog(rand: () => number, size: number): Track[] {
  const tracks: Track[] = [];
  for (let i = 0; i < size; i++) {
    const tagCount = 2 + Math.floor(rand() * 3);
    const tags = new Set<string>();
    while (tags.size < tagCount) {
      tags.add(TAG_VOCAB[Math.floor(rand() * TAG_VOCAB.length)]!);
    }
    tracks.push({
      id: 'sim:' + i,
      sourceId: 'sim',
      title: 'Track ' + i,
      artist: 'Artist ' + Math.floor(i / 4), // ~4 tracks per artist
      artistId: 'a' + Math.floor(i / 4),
      duration: 60 + Math.floor(rand() * 240),
      tags: Array.from(tags),
      playCount: Math.floor(rand() * 2000),
    });
  }
  return tracks;
}

/** The listener's true probability of enjoying a track, given what preceded it. */
function trueAffinity(track: Track, previousTags: string[] = []): number {
  let z = -0.4;
  for (const tag of track.tags) z += HIDDEN_PREFS[tag] ?? 0;
  for (const from of previousTags) {
    for (const to of track.tags) z += HIDDEN_TRANSITIONS[from + '>' + to] ?? 0;
  }
  return 1 / (1 + Math.exp(-z));
}

function simulatePlay(
  track: Track,
  rand: () => number,
  bucket: number,
  previousTags: string[] = [],
): PlayEvent {
  const p = trueAffinity(track, previousTags);
  const enjoyed = rand() < p;

  if (enjoyed) {
    const fraction = 0.9 + rand() * 0.1;
    return {
      ts: Date.now(),
      trackId: track.id,
      outcome: rand() < 0.15 ? 'liked' : 'completed',
      playedFraction: fraction,
      contextBucket: bucket,
    };
  }

  // Dislike shows up as an early skip, with the usual noisy spread.
  return {
    ts: Date.now(),
    trackId: track.id,
    outcome: 'skipped',
    playedFraction: rand() * 0.35,
    contextBucket: bucket,
  };
}

interface RunResult {
  satisfaction: number[];
  novelty: number[];
  finalSatisfaction: number;
  finalNovelty: number;
}

function run(opts: {
  seed: number;
  plays: number;
  useModel: boolean;
  discovery: number;
  /** Whether the model is told what played before. */
  useContext?: boolean;
}): RunResult {
  const rand = mulberry32(opts.seed);
  const catalog = makeCatalog(rand, 600);
  const model = new TasteModel();

  const played = new Set<string>();
  let previousTags: string[] = [];
  const servedAffinity: number[] = [];
  const servedTags: string[][] = [];

  const satisfaction: number[] = [];
  const novelty: number[] = [];
  const WINDOW = 50;

  while (servedAffinity.length < opts.plays) {
    // Recently played tracks are excluded, but the exclusion window is finite —
    // an endless queue over a finite catalogue has to allow eventual repeats.
    const exclude = new Set(Array.from(played).slice(-200));

    const queue = opts.useModel
      ? buildQueue(catalog, model, {
          count: 10,
          discovery: opts.discovery,
          exclude,
          bucket: 2,
          random: rand,
          previousTags: opts.useContext ? previousTags : undefined,
        })
      : catalog
          .filter((t) => !exclude.has(t.id))
          .sort(() => rand() - 0.5)
          .slice(0, 10)
          .map((track) => ({ track, score: 0, explored: false }));

    if (queue.length === 0) break;

    for (const { track } of queue) {
      if (servedAffinity.length >= opts.plays) break;

      servedAffinity.push(trueAffinity(track, previousTags));
      servedTags.push(track.tags);
      played.add(track.id);

      const event = simulatePlay(track, rand, 2, previousTags);
      model.update(
        featurize(track, event.contextBucket, opts.useContext ? previousTags : []),
        labelFor(event),
      );
      previousTags = track.tags.slice(0, 3);

      if (servedAffinity.length % 10 === 0) {
        const recentAff = servedAffinity.slice(-WINDOW);
        satisfaction.push(recentAff.reduce((a, b) => a + b, 0) / recentAff.length);

        const recentTags = new Set<string>();
        for (const tags of servedTags.slice(-WINDOW)) {
          for (const t of tags) recentTags.add(t);
        }
        novelty.push(recentTags.size);
      }
    }
  }

  return {
    satisfaction,
    novelty,
    finalSatisfaction: satisfaction[satisfaction.length - 1] ?? 0,
    finalNovelty: novelty[novelty.length - 1] ?? 0,
  };
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function bar(value: number, max: number, width = 28): string {
  const n = Math.round((value / max) * width);
  return '#'.repeat(Math.max(0, n)).padEnd(width, '.');
}

export function main(): void {
  const PLAYS = 400;
  const SEEDS = [1, 7, 42, 1337, 90210];

  const modelRuns = SEEDS.map((seed) =>
    run({ seed, plays: PLAYS, useModel: true, discovery: 0.2, useContext: true }),
  );
  // Same listener, same seeds, but the model is not told what preceded each
  // track. The gap between this and the run above is what the transition
  // features are worth.
  const blindRuns = SEEDS.map((seed) =>
    run({ seed, plays: PLAYS, useModel: true, discovery: 0.2, useContext: false }),
  );
  const randomRuns = SEEDS.map((seed) =>
    run({ seed, plays: PLAYS, useModel: false, discovery: 0 }),
  );

  console.log('\nDot recommender simulation');
  console.log('%d plays, %d seeds, hidden preference over %d tags\n', PLAYS, SEEDS.length, TAG_VOCAB.length);

  console.log('Satisfaction over time (model, averaged across seeds)');
  const steps = modelRuns[0]!.satisfaction.length;
  for (let i = 0; i < steps; i += Math.max(1, Math.floor(steps / 10))) {
    const v = mean(modelRuns.map((r) => r.satisfaction[i] ?? 0));
    console.log('  play %s  %s  %s', String((i + 1) * 10).padStart(4), bar(v, 1), v.toFixed(3));
  }

  const modelSat = mean(modelRuns.map((r) => r.finalSatisfaction));
  const randomSat = mean(randomRuns.map((r) => r.finalSatisfaction));
  const modelNov = mean(modelRuns.map((r) => r.finalNovelty));
  const randomNov = mean(randomRuns.map((r) => r.finalNovelty));
  const startSat = mean(modelRuns.map((r) => r.satisfaction[0] ?? 0));

  console.log('\nResults');
  console.log('  satisfaction, first 50 plays   %s', startSat.toFixed(3));
  console.log('  satisfaction, last 50 plays    %s', modelSat.toFixed(3));
  console.log('  satisfaction, random baseline  %s', randomSat.toFixed(3));
  console.log('  lift over random               %sx', (modelSat / randomSat).toFixed(2));
  console.log(
    '  without transition context     %s',
    mean(blindRuns.map((r) => r.finalSatisfaction)).toFixed(3),
  );
  console.log('  distinct tags served (model)   %s of %d', modelNov.toFixed(1), TAG_VOCAB.length);
  console.log('  distinct tags served (random)  %s of %d', randomNov.toFixed(1), TAG_VOCAB.length);
  console.log('');
}

main();
