import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseYouTubeInput } from '../src/sources/youtube.ts';

test('parses the link shapes people actually paste', () => {
  assert.deepEqual(parseYouTubeInput('https://www.youtube.com/playlist?list=PLabcdefghij'), {
    kind: 'playlist',
    id: 'PLabcdefghij',
  });
  assert.deepEqual(parseYouTubeInput('https://www.youtube.com/watch?v=ZSM3w1v-A_Y'), {
    kind: 'video',
    id: 'ZSM3w1v-A_Y',
  });
  assert.deepEqual(parseYouTubeInput('https://youtu.be/ZSM3w1v-A_Y'), {
    kind: 'video',
    id: 'ZSM3w1v-A_Y',
  });
  assert.deepEqual(parseYouTubeInput('  ZSM3w1v-A_Y  '), { kind: 'video', id: 'ZSM3w1v-A_Y' });
});

test('a watch link that also carries a list is treated as a playlist', () => {
  // Clicking a track inside a playlist gives this shape, and the intent is
  // almost always the whole playlist.
  assert.deepEqual(
    parseYouTubeInput('https://www.youtube.com/watch?v=ZSM3w1v-A_Y&list=PLabcdefghij&index=3'),
    { kind: 'playlist', id: 'PLabcdefghij' },
  );
});

test('rejects things that are not YouTube links', () => {
  assert.equal(parseYouTubeInput(''), null);
  assert.equal(parseYouTubeInput('   '), null);
  assert.equal(parseYouTubeInput('https://example.com/song.mp3'), null);
  assert.equal(parseYouTubeInput('not a link'), null);
});

/*
 * The YouTube Music shapes. Which `list=` ids the embedded player will actually
 * open was measured against the real player, not guessed — see the table in
 * src/sources/youtube.ts.
 */

test('youtube music albums and curated playlists are playlists', () => {
  assert.deepEqual(
    parseYouTubeInput('https://music.youtube.com/playlist?list=OLAK5uy_neuzTO2KMn_6ilgyHagsib6AXTq8Wv13o'),
    { kind: 'playlist', id: 'OLAK5uy_neuzTO2KMn_6ilgyHagsib6AXTq8Wv13o' },
  );
  assert.deepEqual(
    parseYouTubeInput('https://music.youtube.com/playlist?list=RDCLAK5uy_k4sXYMRc7kePx3BjjVv5z2fB1CePqvVDw'),
    { kind: 'playlist', id: 'RDCLAK5uy_k4sXYMRc7kePx3BjjVv5z2fB1CePqvVDw' },
  );
  // Bare ids, as copied out of a share sheet.
  assert.deepEqual(parseYouTubeInput('OLAK5uy_neuzTO2KMn_6ilgyHagsib6AXTq8Wv13o'), {
    kind: 'playlist',
    id: 'OLAK5uy_neuzTO2KMn_6ilgyHagsib6AXTq8Wv13o',
  });
});

test('a shared song keeps the song, not the radio mix riding along with it', () => {
  // This is exactly what YouTube Music's Share gives you for a track, and the
  // RDAMVM list it attaches is one the player will not enumerate.
  assert.deepEqual(
    parseYouTubeInput('https://music.youtube.com/watch?v=ZSM3w1v-A_Y&list=RDAMVMs22ha_swKAg'),
    { kind: 'video', id: 'ZSM3w1v-A_Y' },
  );
  assert.deepEqual(
    parseYouTubeInput('https://www.youtube.com/watch?v=ZSM3w1v-A_Y&list=RDZSM3w1v-A_Y&start_radio=1'),
    { kind: 'video', id: 'ZSM3w1v-A_Y' },
  );
});

test('lists the player cannot open explain themselves', () => {
  const liked = parseYouTubeInput('https://music.youtube.com/playlist?list=LM');
  assert.equal(liked?.kind, 'unsupported');
  assert.match(liked?.kind === 'unsupported' ? liked.reason : '', /private/i);

  const mix = parseYouTubeInput('https://music.youtube.com/playlist?list=RDAMVMs22ha_swKAg');
  assert.equal(mix?.kind, 'unsupported');
  assert.match(mix?.kind === 'unsupported' ? mix.reason : '', /radio mix/i);

  const browse = parseYouTubeInput('https://music.youtube.com/browse/MPREb_8QtQhOHJvGT');
  assert.equal(browse?.kind, 'unsupported');
  assert.match(browse?.kind === 'unsupported' ? browse.reason : '', /Share/);
});
