import { test } from 'node:test';
import assert from 'node:assert/strict';

import { blockReason, classify, isAllowed } from '../src/sources/filter.ts';

const t = (title: string, artist = 'Some Channel', tags: string[] = []) => ({ title, artist, tags });

test("YouTube's own madeForKids flag is decisive at any level", () => {
  assert.equal(
    blockReason({ ...t('Anything At All'), madeForKids: true }),
    'marked as made for kids',
  );
  // Not even a strong music signal overrides the platform's designation.
  assert.ok(blockReason({ ...t('Nursery Rhyme (Phonk Remix)'), madeForKids: true }));
  assert.equal(blockReason({ ...t('Whatever'), madeForKids: true }, 'off'), null);
});

test('the duck-song long tail is caught — the case that motivated scoring', () => {
  // None of these share a phrase, which is why keyword blocklists missed them.
  assert.ok(!isAllowed(t('Five Little Ducks | Nursery Rhymes')));
  assert.ok(!isAllowed(t('The Duck Song for Kids')));
  assert.ok(!isAllowed(t('Duck Dance | Cartoon for Children')));
  assert.ok(!isAllowed(t('Quack Quack Song', 'Kids TV')));
  assert.ok(!isAllowed(t('Learn Colors with Ducks', 'Fun Learning')));
});

test('classic nursery content is caught', () => {
  assert.ok(!isAllowed(t('Wheels On The Bus')));
  assert.ok(!isAllowed(t('ABC Song')));
  assert.ok(!isAllowed(t('Baby Shark Dance')));
  assert.ok(!isAllowed(t('Anything', 'Cocomelon')));
  assert.ok(!isAllowed(t('Anything', 'Pinkfong')));
});

test('real music survives, including titles full of risky words', () => {
  assert.ok(isAllowed(t('drift phonk lol', 'Weaver Beats', ['phonk', 'driftphonk'])));
  assert.ok(isAllowed(t('Sahara (Slowed + Reverb)', 'Hensonn')));
  assert.ok(isAllowed(t('Murder In My Mind - Bass Boosted', 'Kordhell')));
  // Ordinary songs whose titles contain words the classifier weighs.
  assert.ok(isAllowed(t('Baby', 'Artist - Topic')));
  assert.ok(isAllowed(t('Kids', 'MGMT - Topic')));
  assert.ok(isAllowed(t('Little Dark Age', 'MGMT - Topic')));
  assert.ok(isAllowed(t('Duck Sauce - Barbra Streisand (Official Video)')));
});

test('music signals raise the bar without granting immunity', () => {
  // One music word does not rescue something drenched in children's signals.
  assert.ok(!isAllowed(t('Nursery Rhymes Remix for Kids | Sing Along', 'Kids TV')));
  // But it does rescue a borderline title.
  assert.ok(isAllowed(t('Little Duck (Official Audio)', 'Some Band')));
});

test('strict catches more than normal, and off catches nothing', () => {
  const borderline = t('Happy Little Farm Animals');
  assert.ok(isAllowed(borderline, 'normal'));
  assert.ok(!isAllowed(borderline, 'strict'));
  assert.ok(isAllowed(borderline, 'off'));
  // Strict must still not eat obvious music.
  assert.ok(isAllowed(t('Murder In My Mind', 'Kordhell', ['phonk']), 'strict'));
});

test('non-music formats are filtered when nothing says music', () => {
  assert.ok(!isAllowed(t('Full Episode: the interview')));
  assert.ok(!isAllowed(t('Minecraft gameplay part 4')));
  assert.ok(!isAllowed(t('Guided meditation for sleep')));
});

test('the score and its evidence are reported for tuning', () => {
  const { score, hits } = classify(t('Five Little Ducks | Nursery Rhymes for Kids'));
  assert.ok(score > 10, 'expected a high score, got ' + score);
  assert.ok(hits.length > 0);
  // Reasons carry the score and the top signals, so over-blocking is diagnosable.
  assert.match(blockReason(t('Baby Shark Dance')) ?? '', /children's content \[/);
});

/*
 * Regression group: these are the exact rows that came back for "duck song"
 * while Strict was on. Three of the four channels self-identify as children's
 * channels, which is why channel names now carry their own weight.
 */
test('the real "duck song" results are caught', () => {
  const cases: Array<[string, string]> = [
    ['5 Little Ducks(Learn Colors Song) | Lalafun', 'Lalafun - Nursery Rhymes'],
    ['Five Little Ducks (Learn New Colors) | Lalafun', 'Lalafun - Nursery Rhymes'],
    ['Five Little Ducks | Kids Songs | ZuZoo Nursery Rhymes', 'ZuZoo - Nursery Rhymes'],
    ['Five Little Ducks – Classic Kids Song', 'Candy Heroes | Fun & Educational Kids Songs'],
  ];
  for (const [title, artist] of cases) {
    assert.ok(!isAllowed(t(title, artist), 'strict'), 'should block: ' + title);
    assert.ok(!isAllowed(t(title, artist), 'normal'), 'should block at normal too: ' + title);
  }
});

test('the one the user wanted kept is kept', () => {
  // A novelty song on an ordinary channel: no kid channel, no nursery phrases.
  assert.ok(isAllowed(t('The Duck Song Parts 1-3', '1w1q1o1p'), 'strict'));
});

test('a channel that merely contains "kids" is a hint, not a verdict', () => {
  // Real acts exist with these words in the name; only the strong markers
  // (nursery, rhymes, toddler…) are treated as conclusive on their own.
  assert.ok(isAllowed(t('Feel The Love (Official Audio)', 'Kids See Ghosts')));
  assert.ok(isAllowed(t('4th Dimension', 'KIDS SEE GHOSTS - Topic')));
});
