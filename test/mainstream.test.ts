/*
 * Named, mainstream recordings must reach the feed.
 *
 * Both of this app's classifiers are built to throw things away — one keeps
 * children's uploads out, the other sorts tracks from videos about tracks — and
 * every signal in them was tuned against the long tail. Nothing was checking
 * that ordinary chart pop still gets through, which is the one thing that must
 * never break: a filter that quietly eats Michael Jackson is worse than no
 * filter at all, and it fails silently, because a short feed looks the same as
 * a selective one.
 *
 * Real titles and channel names, because the whole point is that the actual
 * metadata these arrive with survives. Tested at `strict` as well as `normal`,
 * since a user who turns filtering up is not asking to lose the Jackson 5.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { blockReason } from '../src/sources/filter.ts';
import { classifyKind } from '../src/sources/kind.ts';

/** As `videos.list` reports them: official uploads sit in category 10. */
const MUSIC = '10';
const landscape = { width: 480, height: 270 };

interface Target {
  title: string;
  artist: string;
  duration: number;
  categoryId?: string;
}

const TARGETS: Target[] = [
  { title: 'Michael Jackson - Billie Jean (Official Video)', artist: 'michaeljacksonVEVO', duration: 294, categoryId: MUSIC },
  { title: 'Michael Jackson - Beat It (Official Video)', artist: 'michaeljacksonVEVO', duration: 298, categoryId: MUSIC },
  { title: 'Michael Jackson - Smooth Criminal (Official Video)', artist: 'michaeljacksonVEVO', duration: 557, categoryId: MUSIC },
  { title: 'Michael Jackson - Thriller (Official Video)', artist: 'michaeljacksonVEVO', duration: 822, categoryId: MUSIC },
  { title: 'Michael Jackson - Bad (Official Video)', artist: 'michaeljacksonVEVO', duration: 1086, categoryId: MUSIC },
  { title: 'OneRepublic - Apologize', artist: 'OneRepublicVEVO', duration: 208, categoryId: MUSIC },
  { title: "*NSYNC - Bye Bye Bye (Official Video)", artist: 'NSYNCVEVO', duration: 200, categoryId: MUSIC },
];

test('the named targets are not filtered out', () => {
  for (const target of TARGETS) {
    for (const level of ['normal', 'strict'] as const) {
      assert.equal(
        blockReason(target, level),
        null,
        `${level} blocked: ${target.title}`,
      );
    }
  }
});

test('the named targets are classified as music, not video', () => {
  for (const target of TARGETS) {
    assert.equal(
      classifyKind({ ...target, tags: [], aspect: landscape }),
      'music',
      `misclassified: ${target.title}`,
    );
  }
});

/*
 * Several Jackson 5 tracks run under the three-minute Shorts ceiling, and
 * duration is half of how a Short is recognised. The other half is a portrait
 * embed — which the API only reports when asked for it, so it is frequently
 * absent. A two-and-a-half minute song with no dimensions available must not
 * fall through to the Shorts tab.
 */
test('a song shorter than the Shorts ceiling is still music', () => {
  const abc = { title: 'ABC', artist: 'Jackson 5 - Topic', tags: [] as string[], duration: 158 };

  assert.equal(classifyKind({ ...abc, categoryId: MUSIC }), 'music');
  assert.equal(classifyKind({ ...abc, categoryId: MUSIC, aspect: landscape }), 'music');
  // No category and no dimensions: the Topic-channel suffix has to carry it.
  assert.equal(classifyKind(abc), 'music');
});

/*
 * Words the children's filter weighs do appear in this catalogue. Each is
 * individually under the threshold by design — the rule is that single words
 * stay cheap — but the arithmetic is worth pinning, because raising any one of
 * those weights later would silently start eating real songs.
 */
test('kid-adjacent words in real song titles do not block them', () => {
  const songs = [
    { title: 'Michael Jackson - Heal The World (Official Video)', artist: 'michaeljacksonVEVO', tags: ['children', 'charity'] },
    { title: 'Michael Jackson - Childhood (Official Video)', artist: 'michaeljacksonVEVO', tags: [] },
    { title: 'Michael Jackson - Little Susie', artist: 'Michael Jackson - Topic', tags: [] },
    { title: 'Michael Jackson - Ben', artist: 'Michael Jackson - Topic', tags: [] },
    { title: 'The Jackson 5 - Rockin Robin', artist: 'Jackson 5 - Topic', tags: [] },
  ];

  for (const song of songs) {
    assert.equal(blockReason(song, 'normal'), null, `blocked: ${song.title}`);
  }
});

/*
 * The counterpart: the filter still has to work. If the assertions above were
 * passing because filtering had been turned off or broken outright, this fails.
 */
test('the filter is still filtering', () => {
  assert.ok(blockReason({ title: 'Five Little Ducks | Nursery Rhymes', artist: 'CoComelon', tags: [] }, 'normal'));
  assert.ok(blockReason({ title: 'Michael Jackson - Bad', artist: 'michaeljacksonVEVO', madeForKids: true }, 'normal'));
});
