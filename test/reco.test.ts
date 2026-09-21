import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TasteModel, labelFor, sigmoid } from '../src/reco/model.ts';
import { buildQueue, exploreRate } from '../src/reco/queue.ts';
import { featurize, contextBucket, normalizeTag } from '../src/reco/features.ts';
import type { PlayEvent, Track } from '../src/types.ts';

function track(id: string, tags: string[], artistId = 'a1', duration = 180): Track {
  return {
    id,
    sourceId: 'test',
    title: id,
    artist: artistId,
    artistId,
    duration,
    tags,
  };
}

function event(outcome: PlayEvent['outcome'], playedFraction: number): PlayEvent {
  return { ts: 0, trackId: 't', outcome, playedFraction, contextBucket: 0 };
}

test('sigmoid is stable at extremes', () => {
  assert.ok(Number.isFinite(sigmoid(1000)));
  assert.ok(Number.isFinite(sigmoid(-1000)));
  assert.equal(sigmoid(0), 0.5);
  assert.ok(sigmoid(800) > 0.99);
  assert.ok(sigmoid(-800) < 0.01);
});

test('skip weight scales with how much was left unplayed', () => {
  const early = labelFor(event('skipped', 0.1));
  const late = labelFor(event('skipped', 0.8));

  assert.equal(early.y, 0);
  assert.equal(late.y, 0);
  // Abandoning a track early is a far stronger negative than abandoning it late.
  assert.ok(early.weight > late.weight, 'early skip should outweigh late skip');
  assert.ok(Math.abs(early.weight - 0.9) < 1e-9);
  assert.ok(Math.abs(late.weight - 0.2) < 1e-9);
});

test('a skip past the completion threshold counts as a positive', () => {
  const l = labelFor(event('skipped', 0.95));
  assert.equal(l.y, 1);
});

test('a skip in the first moments is discounted as a mis-tap', () => {
  const mistap = labelFor(event('skipped', 0.01));
  const deliberate = labelFor(event('skipped', 0.2));
  assert.ok(mistap.weight < deliberate.weight);
});

test('playback errors never train the model', () => {
  assert.equal(labelFor(event('error', 0.3)).weight, 0);
});

test('explicit feedback outweighs implicit', () => {
  assert.ok(labelFor(event('liked', 1)).weight > labelFor(event('completed', 1)).weight);
  assert.ok(labelFor(event('disliked', 0)).weight > labelFor(event('skipped', 0)).weight);
});

test('model separates liked tags from disliked ones', () => {
  const model = new TasteModel();
  const good = track('g', ['phonk', 'memphis']);
  const bad = track('b', ['classical', 'piano'], 'a2');

  for (let i = 0; i < 40; i++) {
    model.update(featurize(good, 0), labelFor(event('completed', 1)));
    model.update(featurize(bad, 0), labelFor(event('skipped', 0.05)));
  }

  assert.ok(
    model.score(featurize(good, 0)) > model.score(featurize(bad, 0)),
    'liked tags should outrank disliked tags',
  );
  assert.ok(model.score(featurize(good, 0)) > 0.6);
  assert.ok(model.score(featurize(bad, 0)) < 0.4);
});

test('cold-start seeding biases scores before any real play', () => {
  const seeded = new TasteModel();
  seeded.seed(['phonk'], []);

  const phonk = track('p', ['phonk']);
  const folk = track('f', ['folk'], 'a2');

  assert.ok(seeded.score(featurize(phonk, 0)) > seeded.score(featurize(folk, 0)));
  // Seeding is synthetic, so it must not count as engagement for explore decay.
  assert.equal(seeded.n, 0);
});

test('model survives a JSON round trip', () => {
  const model = new TasteModel();
  const t = track('x', ['phonk']);
  for (let i = 0; i < 10; i++) model.update(featurize(t, 0), labelFor(event('liked', 1)));

  const restored = TasteModel.fromJSON(JSON.parse(JSON.stringify(model)));
  assert.ok(restored);
  assert.equal(restored!.n, model.n);
  assert.ok(Math.abs(restored!.score(featurize(t, 0)) - model.score(featurize(t, 0))) < 1e-6);
});

test('a corrupt or stale snapshot is rejected rather than trusted', () => {
  assert.equal(TasteModel.fromJSON(null), null);
  assert.equal(TasteModel.fromJSON({ version: 999, w: [], accum: [] }), null);
  assert.equal(TasteModel.fromJSON({ version: 1, w: [1, 2], accum: [1, 2], n: 0 }), null);
});

test('exploration decays once the model has evidence', () => {
  assert.equal(exploreRate(0.2, 0), 0.2);
  assert.equal(exploreRate(0.2, 500), 0.1);
  assert.equal(exploreRate(0, 0), 0);
});

test('queue caps how often one artist can appear', () => {
  const candidates: Track[] = [];
  // 30 tracks all by the same artist, plus a few others to fall back on.
  for (let i = 0; i < 30; i++) candidates.push(track('hog' + i, ['phonk'], 'hog'));
  for (let i = 0; i < 30; i++) candidates.push(track('other' + i, ['trap'], 'other' + i));

  const model = new TasteModel();
  const queue = buildQueue(candidates, model, {
    count: 20,
    discovery: 0,
    bucket: 0,
    random: () => 0.99, // never explore, so only the cap can create variety
  });

  const hogCount = queue.filter((r) => r.track.artistId === 'hog').length;
  assert.ok(hogCount <= 2, `one artist took ${hogCount} of 20 slots`);
});

test('queue never repeats an excluded track', () => {
  const candidates = Array.from({ length: 20 }, (_, i) => track('t' + i, ['phonk'], 'a' + i));
  const exclude = new Set(['t0', 't1', 't2']);

  const queue = buildQueue(candidates, new TasteModel(), {
    count: 10,
    discovery: 0,
    exclude,
    bucket: 0,
    random: () => 0.99,
  });

  for (const r of queue) assert.ok(!exclude.has(r.track.id));
});

test('queue deduplicates tracks blended from several sources', () => {
  const dupe = track('same', ['phonk'], 'a1');
  const queue = buildQueue([dupe, { ...dupe }, track('other', ['trap'], 'a2')], new TasteModel(), {
    count: 10,
    discovery: 0,
    bucket: 0,
    random: () => 0.99,
  });

  const ids = queue.map((r) => r.track.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('a monotonous candidate pool still yields a varied queue', () => {
  // 40 near-identical phonk tracks, and 10 tracks covering other tags.
  const candidates: Track[] = [];
  for (let i = 0; i < 40; i++) candidates.push(track('p' + i, ['phonk'], 'a' + i));
  const others = ['jazz', 'techno', 'folk', 'rock', 'soul', 'disco', 'dnb', 'punk', 'lofi', 'funk'];
  others.forEach((tag, i) => candidates.push(track('o' + i, [tag], 'b' + i)));

  const queue = buildQueue(candidates, new TasteModel(), {
    count: 20,
    discovery: 0,
    bucket: 0,
    random: () => 0.99,
  });

  const tags = new Set(queue.flatMap((r) => r.track.tags.map(normalizeTag)));
  assert.ok(tags.size >= 5, `queue spanned only ${tags.size} distinct tags`);
});

test('queue returns what it can when the pool is smaller than requested', () => {
  const queue = buildQueue([track('only', ['phonk'])], new TasteModel(), {
    count: 20,
    discovery: 0,
    bucket: 0,
    random: () => 0.99,
  });
  assert.equal(queue.length, 1);
});

test('time-of-day buckets partition the day', () => {
  assert.equal(contextBucket(new Date(2026, 0, 1, 3)), 0);
  assert.equal(contextBucket(new Date(2026, 0, 1, 9)), 1);
  assert.equal(contextBucket(new Date(2026, 0, 1, 14)), 2);
  assert.equal(contextBucket(new Date(2026, 0, 1, 21)), 3);
});

test('tag normalization collapses the spellings a catalogue actually contains', () => {
  assert.equal(normalizeTag('Drift Phonk'), 'driftphonk');
  assert.equal(normalizeTag('  BASS_BOOST '), 'bassboost');
});

test('identical tracks in different contexts score differently once context is learned', () => {
  const model = new TasteModel();
  const t = track('t', ['phonk']);

  // Liked at night, skipped in the morning.
  for (let i = 0; i < 30; i++) {
    model.update(featurize(t, 0), labelFor(event('completed', 1)));
    model.update(featurize(t, 1), labelFor(event('skipped', 0.05)));
  }

  assert.ok(model.score(featurize(t, 0)) > model.score(featurize(t, 1)));
});

test('a worn-out tag loses ground to a fresh one', () => {
  // Fatigue is what stops a feed spending an hour on whichever tag the model
  // happens to like best, without banning that tag outright.
  const model = new TasteModel();
  const worn = track('worn', ['phonk'], 'a1');
  const fresh = track('fresh', ['phonk', 'techno'], 'a2');

  const fatigue = new Map([['phonk', 20]]);
  const queue = buildQueue([worn, fresh], model, {
    count: 2,
    discovery: 0,
    bucket: 0,
    random: () => 0.99,
    fatigue,
  });

  // Both carry the tired tag, but only one also offers something else.
  assert.equal(queue.length, 2);
  assert.ok(queue[0]!.score <= 0.5, 'a worn tag should be marked down');
});

test('fatigue is bounded, so a favourite genre is never banished', () => {
  const model = new TasteModel();
  const t = track('t', ['phonk'], 'a1');

  const mild = buildQueue([t], model, {
    count: 1, discovery: 0, bucket: 0, random: () => 0.99,
    fatigue: new Map([['phonk', 5]]),
  });
  const extreme = buildQueue([t], model, {
    count: 1, discovery: 0, bucket: 0, random: () => 0.99,
    fatigue: new Map([['phonk', 5000]]),
  });

  // Five thousand plays must not cost meaningfully more than a handful past
  // the cap, or the tag would effectively be removed from the catalogue.
  assert.ok(Math.abs(mild[0]!.score - extreme[0]!.score) < 0.3);
});

test('no fatigue map leaves scoring untouched', () => {
  const model = new TasteModel();
  const t = track('t', ['phonk'], 'a1');
  const plain = buildQueue([t], model, { count: 1, discovery: 0, bucket: 0, random: () => 0.99 });
  const empty = buildQueue([t], model, {
    count: 1, discovery: 0, bucket: 0, random: () => 0.99, fatigue: new Map(),
  });
  assert.equal(plain[0]!.score, empty[0]!.score);
});
