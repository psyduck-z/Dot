import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyKind, hasShortsMarker, isPortrait, parseEmbedAspect } from '../src/sources/kind.ts';

const base = { title: '', artist: 'Channel', tags: [] as string[], duration: 200 };
const portrait = { width: 315, height: 560 };
const landscape = { width: 560, height: 315 };

test('a vertical, brief video is a Short', () => {
  assert.equal(classifyKind({ ...base, duration: 45, aspect: portrait }), 'short');
  assert.equal(classifyKind({ ...base, duration: 179, aspect: portrait }), 'short');
});

test('vertical but long is not a Short', () => {
  // Shorts cap at three minutes; a vertical 10-minute upload is a video.
  assert.equal(classifyKind({ ...base, duration: 600, aspect: portrait }), 'video');
});

test('brief but landscape is not a Short', () => {
  assert.equal(classifyKind({ ...base, duration: 45, aspect: landscape }), 'video');
  // Duration alone must not imply Short — plenty of songs are under 3 minutes.
  assert.equal(classifyKind({ ...base, duration: 45 }), 'video');
  assert.equal(classifyKind({ ...base, duration: 150, categoryId: '10' }), 'music');
});

/*
 * The Shorts tab came up empty because the API only reports embed dimensions
 * when asked, so orientation was almost always unknown. The #shorts tag is the
 * signal that survives without it.
 */
test('the #shorts convention identifies a Short without dimensions', () => {
  assert.equal(classifyKind({ ...base, duration: 30, title: 'drift edit #shorts' }), 'short');
  assert.equal(classifyKind({ ...base, duration: 30, tags: ['shorts', 'phonk'] }), 'short');
  assert.equal(classifyKind({ ...base, duration: 30, tags: ['#shorts'] }), 'short');
});

test('the marker alone is not enough if the video is long', () => {
  // Uploaders tag full videos #shorts to game search; duration still gates it.
  assert.equal(classifyKind({ ...base, duration: 900, title: 'full mix #shorts' }), 'video');
});

test('shorts markers are detected but ordinary words are not', () => {
  assert.ok(hasShortsMarker({ ...base, title: 'clip #shorts' }));
  assert.ok(hasShortsMarker({ ...base, tags: ['Shorts'] }));
  assert.ok(!hasShortsMarker({ ...base, title: 'wearing shorts in winter' }));
});

test("the platform's Music category settles it", () => {
  assert.equal(classifyKind({ ...base, categoryId: '10' }), 'music');
  // Even with an unhelpful title.
  assert.equal(classifyKind({ ...base, title: 'untitled', categoryId: '10' }), 'music');
});

test('auto-generated Topic channels are always music', () => {
  assert.equal(classifyKind({ ...base, artist: 'Kordhell - Topic' }), 'music');
});

test('music filed under another category is still caught by its title', () => {
  // Music videos are routinely uploaded under Entertainment.
  assert.equal(
    classifyKind({ ...base, title: 'Apologize (Official Music Video)', categoryId: '24' }),
    'music',
  );
  assert.equal(
    classifyKind({ ...base, title: 'Sahara (Slowed + Reverb)', categoryId: '24' }),
    'music',
  );
});

test('ordinary videos stay videos', () => {
  assert.equal(classifyKind({ ...base, title: 'Top 5 phonk songs of the month' }), 'video');
  assert.equal(classifyKind({ ...base, title: 'How I built my PC', categoryId: '28' }), 'video');
});

test('a vertical music clip is a Short, not a track', () => {
  // Surface wins over genre: it belongs in the Shorts feed either way.
  assert.equal(
    classifyKind({ ...base, duration: 40, aspect: portrait, categoryId: '10' }),
    'short',
  );
});

test('embed dimensions are read out of the API markup', () => {
  assert.deepEqual(
    parseEmbedAspect('<iframe width="560" height="315" src="..."></iframe>'),
    { width: 560, height: 315 },
  );
  assert.equal(parseEmbedAspect(undefined), undefined);
  assert.equal(parseEmbedAspect('<iframe src="..."></iframe>'), undefined);
});

test('orientation is read from the dimensions', () => {
  assert.ok(isPortrait(portrait));
  assert.ok(!isPortrait(landscape));
  assert.ok(!isPortrait(undefined));
  assert.ok(!isPortrait({ width: 0, height: 0 }));
});

test('a video about music is a video, not a track', () => {
  // Caught by the test suite: genre words say the subject is music, not that
  // the upload is a recording. This exact title was being filed under Music.
  assert.equal(classifyKind({ ...base, title: 'Top 5 phonk songs of the month' }), 'video');
  assert.equal(classifyKind({ ...base, title: 'Ranking every phonk album' }), 'video');
  assert.equal(classifyKind({ ...base, title: 'First time hearing Kordhell' }), 'video');
  // But a genuine release with the same genre word is still music.
  assert.equal(classifyKind({ ...base, title: 'Murder In My Mind (Official Audio)' }), 'music');
});
