/**
 * Content classifier for the YouTube source.
 *
 * Keyword blocklists were not enough. A query like "duck song" returns dozens
 * of children's uploads whose titles share no single phrase — "Five Little
 * Ducks", "Duck Dance | Cartoon for Children", "Quack Quack Song" — so matching
 * exact strings either misses most of them or, if broadened to bare words,
 * starts eating real music.
 *
 * So this is a small scoring model instead: a naive-Bayes-style log-odds sum
 * over weighted phrases and tokens. Each signal contributes evidence, positive
 * for children's content and negative for music, and the total is compared
 * against a threshold the user controls. It costs microseconds, has no
 * dependencies, and is small enough to run on watch hardware.
 *
 * Two design rules keep it from eating real music:
 *
 *  1. Single words carry low weight; only multi-word phrases and channel names
 *     carry high weight. "Baby", "kids" and "little" all appear in ordinary
 *     song titles.
 *  2. Music signals subtract. A phonk edit or an "official audio" upload has to
 *     clear a much higher bar before it is treated as children's content.
 *
 * YouTube's own `madeForKids` flag bypasses all of it and blocks outright.
 */

/** Weighted evidence. Positive means childish, negative means music. */
interface Signal {
  readonly match: string;
  readonly weight: number;
}

/**
 * Multi-word phrases, matched against the whole text. These are high-confidence:
 * essentially nothing but children's content contains them.
 */
const PHRASES: readonly Signal[] = [
  { match: 'nursery rhyme', weight: 6 },
  { match: 'for kids', weight: 5 },
  { match: 'for children', weight: 5 },
  { match: 'for babies', weight: 5 },
  { match: 'for toddlers', weight: 5 },
  { match: 'kids song', weight: 5 },
  { match: 'kids songs', weight: 5 },
  { match: 'children song', weight: 5 },
  { match: 'childrens song', weight: 5 },
  { match: 'baby song', weight: 5 },
  { match: 'baby shark', weight: 6 },
  { match: 'sing along', weight: 4 },
  { match: 'singalong', weight: 4 },
  { match: 'finger family', weight: 6 },
  { match: 'five little', weight: 6 },
  { match: 'ten little', weight: 6 },
  { match: 'three little', weight: 5 },
  { match: '5 little', weight: 6 },
  { match: '10 little', weight: 6 },
  { match: '3 little', weight: 5 },
  { match: '4 little', weight: 5 },
  { match: 'little ducks', weight: 6 },
  { match: 'wheels on the bus', weight: 6 },
  { match: 'head shoulders', weight: 6 },
  { match: 'itsy bitsy', weight: 6 },
  { match: 'twinkle twinkle', weight: 6 },
  { match: 'old macdonald', weight: 6 },
  { match: 'old mcdonald', weight: 6 },
  { match: 'abc song', weight: 6 },
  { match: 'alphabet song', weight: 6 },
  { match: 'phonics song', weight: 6 },
  { match: 'counting song', weight: 5 },
  { match: 'learn colors', weight: 5 },
  { match: 'learn colours', weight: 5 },
  { match: 'learn numbers', weight: 5 },
  { match: 'learn the', weight: 3 },
  { match: 'learning video', weight: 5 },
  { match: 'educational video', weight: 5 },
  { match: 'bedtime story', weight: 5 },
  { match: 'story time', weight: 4 },
  { match: 'kids tv', weight: 5 },
  { match: 'kids cartoon', weight: 5 },
  { match: 'cartoon for', weight: 5 },
  { match: 'animation for', weight: 4 },
  { match: '3d animation', weight: 3 },
  { match: 'kids video', weight: 5 },
  { match: 'baby sensory', weight: 6 },
  { match: 'tummy time', weight: 5 },
  { match: 'good morning song', weight: 4 },
  { match: 'clean up song', weight: 5 },
  { match: 'potty training', weight: 6 },
  { match: 'quack quack', weight: 5 },
  { match: 'moo moo', weight: 4 },
  { match: 'choo choo', weight: 4 },
  { match: 'peekaboo', weight: 4 },
  { match: 'peek a boo', weight: 4 },
  { match: 'happy birthday song', weight: 3 },
];

/**
 * Single words, matched on word boundaries. Weights are deliberately low —
 * each is only a hint, and it takes several to cross the threshold.
 */
const TOKENS: readonly Signal[] = [
  { match: 'nursery', weight: 4 },
  { match: 'lullaby', weight: 4 },
  { match: 'lullabies', weight: 4 },
  { match: 'toddler', weight: 4 },
  { match: 'toddlers', weight: 4 },
  { match: 'preschool', weight: 4 },
  { match: 'kindergarten', weight: 4 },
  { match: 'rhymes', weight: 3 },
  { match: 'kiddie', weight: 4 },
  { match: 'kiddies', weight: 4 },
  { match: 'childrens', weight: 3 },
  { match: 'children', weight: 2 },
  { match: 'kids', weight: 2 },
  { match: 'babies', weight: 2.5 },
  { match: 'cartoon', weight: 2 },
  { match: 'cartoons', weight: 2 },
  { match: 'animated', weight: 1.5 },
  { match: 'educational', weight: 2.5 },
  { match: 'quack', weight: 3 },
  { match: 'oink', weight: 3 },
  { match: 'ducky', weight: 3 },
  { match: 'piggy', weight: 2 },
  { match: 'bunny', weight: 1.5 },
  { match: 'teddy', weight: 1.5 },
  { match: 'playtime', weight: 3 },
  { match: 'playground', weight: 1.5 },
  { match: 'nap', weight: 1 },
  { match: 'baby', weight: 1 },
  { match: 'little', weight: 0.8 },
  { match: 'duck', weight: 1.2 },
  { match: 'ducks', weight: 1.5 },
  { match: 'farm', weight: 1 },
  { match: 'animals', weight: 1 },
  { match: 'colors', weight: 0.8 },
  { match: 'colours', weight: 0.8 },
  { match: 'shapes', weight: 0.8 },
  { match: 'counting', weight: 2 },
  { match: 'silly', weight: 1 },
  { match: 'yummy', weight: 1.5 },
  { match: 'tiny', weight: 0.8 },
];

/** Channel names whose whole output is children's content. Decisive on their own. */
const KID_CHANNELS: readonly string[] = [
  'cocomelon',
  'pinkfong',
  'chuchu tv',
  'chuchutv',
  'little baby bum',
  'super simple songs',
  'blippi',
  'ms rachel',
  'miss rachel',
  'kids tv',
  'babybus',
  'baby bus',
  'looloo kids',
  'dave and ava',
  'mother goose club',
  'bounce patrol',
  'the kiboomers',
  'hooplakidz',
  'nursery rhymes',
  'kidz bop',
  'baby einstein',
  'sesame street',
];

/**
 * Words that, in a channel name, mean the channel makes children's content.
 * Matched with a leading space so "kids" does not fire inside another word.
 */
const CHANNEL_MARKERS: readonly Signal[] = [
  { match: 'nursery', weight: 7 },
  { match: 'rhymes', weight: 7 },
  { match: 'toddler', weight: 7 },
  { match: 'preschool', weight: 7 },
  { match: 'babies', weight: 7 },
  { match: 'childrens', weight: 7 },
  { match: 'kiddie', weight: 7 },
  // Weaker: these do appear in real band and label names.
  { match: 'kids', weight: 3 },
  { match: 'children', weight: 3 },
  { match: 'baby', weight: 3 },
  { match: 'cartoon', weight: 3 },
  { match: 'learning', weight: 3 },
  { match: 'educational', weight: 3 },
];

/**
 * Evidence the upload is music. Negative weights, so these raise the bar rather
 * than granting immunity — a nursery rhyme compilation labelled "remix" should
 * still be caught.
 */
const MUSIC_SIGNALS: readonly Signal[] = [
  { match: 'phonk', weight: -8 },
  { match: 'type beat', weight: -7 },
  { match: 'prod.', weight: -6 },
  { match: 'prod by', weight: -6 },
  { match: 'official audio', weight: -6 },
  { match: 'official video', weight: -5 },
  { match: 'official music video', weight: -6 },
  { match: 'lyric video', weight: -5 },
  { match: 'lyrics', weight: -4 },
  { match: 'slowed', weight: -6 },
  { match: 'reverb', weight: -6 },
  { match: 'bass boosted', weight: -6 },
  { match: 'bassboosted', weight: -6 },
  { match: 'sped up', weight: -5 },
  { match: 'nightcore', weight: -5 },
  { match: 'remix', weight: -5 },
  { match: 'bootleg', weight: -5 },
  { match: 'mixtape', weight: -5 },
  { match: 'instrumental', weight: -4 },
  { match: 'extended mix', weight: -5 },
  { match: 'club mix', weight: -5 },
  { match: 'radio edit', weight: -5 },
  { match: 'feat.', weight: -4 },
  { match: ' ft.', weight: -4 },
  { match: 'explicit', weight: -6 },
  { match: 'soundtrack', weight: -3 },
  { match: 'acoustic', weight: -3 },
  { match: 'live session', weight: -3 },
  { match: 'full album', weight: -3 },
];

/** Formats that are not music at all. */
const NON_MUSIC_PHRASES: readonly string[] = [
  'full episode',
  'full podcast',
  'podcast ep',
  'gameplay',
  'walkthrough',
  'speedrun',
  'unboxing',
  'how to make',
  'tutorial for',
  'reacts to',
  'reaction video',
  'official trailer',
  'movie trailer',
  'news report',
  'press conference',
  'full interview',
  'audiobook',
  'guided meditation',
];

/** Emoji that essentially only appear on children's uploads. */
const KID_EMOJI = /[\u{1F984}\u{1F308}\u{1F36D}\u{1F9F8}\u{1F423}\u{1F425}\u{1F986}\u{1F437}\u{1F42E}\u{1F411}]/u;

export type FilterLevel = 'off' | 'normal' | 'strict';

/**
 * Score above which a track is treated as children's content.
 * Strict is roughly "one strong phrase, or a few weak hints".
 */
const THRESHOLD: Record<Exclude<FilterLevel, 'off'>, number> = {
  normal: 4.5,
  strict: 2.5,
};

export interface FilterInput {
  title: string;
  artist: string;
  tags?: string[];
  /** YouTube's own `status.madeForKids`, when we have it. */
  madeForKids?: boolean;
}

export interface Classification {
  score: number;
  /** Which signals fired, strongest first — so over-blocking is diagnosable. */
  hits: Array<{ signal: string; weight: number }>;
}

function normalize(text: string): string {
  return ' ' + text.toLowerCase().replace(/[^a-z0-9.\s]/g, ' ').replace(/\s+/g, ' ') + ' ';
}

function tokensOf(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 0));
}

/**
 * Scores how childish a track looks. Exported so the score can be logged and
 * the thresholds tuned against real results rather than guessed at.
 */
export function classify(input: FilterInput): Classification {
  const raw = input.title + ' ' + input.artist + ' ' + (input.tags ?? []).join(' ');
  const text = normalize(raw);
  const words = tokensOf(raw);
  const artist = normalize(input.artist);

  const hits: Array<{ signal: string; weight: number }> = [];
  let score = 0;

  let channelHit = false;
  for (const channel of KID_CHANNELS) {
    if (artist.indexOf(channel) >= 0) {
      hits.push({ signal: 'channel:' + channel, weight: 10 });
      score += 10;
      channelHit = true;
      break;
    }
  }

  // A named blocklist never keeps up with how many of these channels exist,
  // and it does not need to: they almost all say what they are in their own
  // name. Channel names are far more reliable than titles here, because an
  // uploader who calls themselves "… - Nursery Rhymes" makes nothing else.
  if (!channelHit) {
    for (const marker of CHANNEL_MARKERS) {
      if (artist.indexOf(' ' + marker.match) >= 0) {
        hits.push({ signal: 'channel:' + marker.match, weight: marker.weight });
        score += marker.weight;
        break;
      }
    }
  }

  for (const signal of PHRASES) {
    if (text.indexOf(signal.match) >= 0) {
      hits.push({ signal: signal.match, weight: signal.weight });
      score += signal.weight;
    }
  }

  for (const signal of TOKENS) {
    if (words.has(signal.match)) {
      hits.push({ signal: signal.match, weight: signal.weight });
      score += signal.weight;
    }
  }

  if (KID_EMOJI.test(raw)) {
    hits.push({ signal: 'kid emoji', weight: 2 });
    score += 2;
  }

  for (const signal of MUSIC_SIGNALS) {
    if (text.indexOf(signal.match) >= 0) {
      hits.push({ signal: signal.match, weight: signal.weight });
      score += signal.weight;
    }
  }

  // Auto-generated music channels are named "Artist - Topic" and only ever
  // carry properly released tracks, which is a strong signal on its own.
  if (/\s-\s*topic\s*$/.test(input.artist.toLowerCase())) {
    hits.push({ signal: 'topic channel', weight: -5 });
    score -= 5;
  }

  hits.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  return { score, hits };
}

/**
 * Markers that a page is a released recording rather than a video about music.
 *
 * Deliberately excludes genre names. "Phonk" tells you the subject is music,
 * not that the upload *is* a track — "Top 5 phonk songs of the month" is a
 * countdown video. Only release and production conventions are counted.
 */
const RELEASE_MARKERS: readonly string[] = [
  'official audio',
  'official video',
  'official music video',
  'lyric video',
  'lyrics',
  'slowed',
  'reverb',
  'bass boosted',
  'bassboosted',
  'sped up',
  'nightcore',
  'remix',
  'bootleg',
  'mixtape',
  'instrumental',
  'extended mix',
  'club mix',
  'radio edit',
  'feat.',
  ' ft.',
  'prod.',
  'prod by',
  'type beat',
  'acoustic',
  'live session',
  'full album',
];

/** Formats that discuss music instead of being it. */
const ABOUT_MUSIC: readonly string[] = [
  'top 5',
  'top 10',
  'top 20',
  'top 50',
  'best ',
  'worst ',
  'ranking',
  'ranked',
  'tier list',
  'explained',
  'breakdown',
  'documentary',
  'the story of',
  'history of',
  'review',
  'reacting',
  'first time hearing',
];

/**
 * How strongly a track reads as an actual recording, as a positive number.
 *
 * Used to sort music apart from ordinary videos when the platform's own
 * category is missing or wrong. Distinct from the children's filter's signal
 * table, which counts genre words too — there, "phonk" is decisive evidence
 * that something is not a nursery rhyme; here it says nothing about whether
 * the upload is a track or a video discussing tracks.
 */
export function musicScore(input: FilterInput): number {
  const text = normalize(input.title + ' ' + input.artist + ' ' + (input.tags ?? []).join(' '));
  let score = 0;
  for (const marker of RELEASE_MARKERS) {
    if (text.indexOf(marker) >= 0) score += 6;
  }
  for (const phrase of ABOUT_MUSIC) {
    if (text.indexOf(phrase) >= 0) score -= 6;
  }
  for (const phrase of NON_MUSIC_PHRASES) {
    if (text.indexOf(phrase) >= 0) score -= 6;
  }
  return score;
}

function looksMusical(input: FilterInput): boolean {
  const text = normalize(input.title + ' ' + input.artist + ' ' + (input.tags ?? []).join(' '));
  return MUSIC_SIGNALS.some((s) => text.indexOf(s.match) >= 0);
}

/**
 * Returns a reason when the track should be kept out of the feed, or null when
 * it is fine. A reason string rather than a boolean, so the console log can say
 * why and the thresholds can be tuned against reality.
 */
export function blockReason(input: FilterInput, level: FilterLevel = 'normal'): string | null {
  if (level === 'off') return null;

  // The platform's own designation is not worth second-guessing.
  if (input.madeForKids === true) return 'marked as made for kids';

  const text = normalize(input.title + ' ' + input.artist + ' ' + (input.tags ?? []).join(' '));
  const musical = looksMusical(input);

  if (!musical) {
    for (const phrase of NON_MUSIC_PHRASES) {
      if (text.indexOf(phrase) >= 0) return 'not music (' + phrase + ')';
    }
  }

  const { score, hits } = classify(input);
  if (score >= THRESHOLD[level]) {
    const top = hits
      .filter((h) => h.weight > 0)
      .slice(0, 3)
      .map((h) => h.signal)
      .join(', ');
    return "children's content [" + score.toFixed(1) + ': ' + top + ']';
  }

  return null;
}

export function isAllowed(input: FilterInput, level: FilterLevel = 'normal'): boolean {
  return blockReason(input, level) === null;
}
