/**
 * The Dot application.
 *
 * Structured the way Spotify is, because that layout is what people already know
 * how to operate: Home / Search / Library tabs, horizontally scrolling shelves
 * of cards, a persistent mini player docked above the tab bar, and a full-screen
 * Now Playing that slides up over everything.
 *
 * Screens are built once and shown or hidden rather than re-rendered, so scroll
 * position and audio survive navigation.
 */

import { YouTubeSource } from './sources/youtube.ts';
import { YouTubeEngine } from './playback/youtube.ts';
import { Player } from './player.ts';
import { TasteModel, labelFor } from './reco/model.ts';
import { buildQueue, exploreRate, type RankedTrack } from './reco/queue.ts';
import { contextBucket, featurize, hashKey, normalizeTag } from './reco/features.ts';
import * as store from './store.ts';
import { crashContext, recentCrashes, clearCrashes, crashedRecently, crashedTrackIds } from './crash.ts';
import { mirrorStatus, mirrorEnabled, setMirrorEnabled } from './remote.ts';
import {
  checkForUpdate,
  isRunningDownloaded,
  runningVersion,
  setUpdateUrl,
  updateUrl,
  usingDefaultUpdateUrl,
} from './updater.ts';
import { button, clear, el, formatTime, paintArt, tintFor, ytThumb } from './ui/dom.ts';
import type { Channel, MusicSource, PlayEvent, Prefs, Track, TrackId } from './types.ts';
import type { TrackKind } from './sources/kind.ts';

/** Offered during onboarding and on the Search browse grid. Tags, not genres —
 *  the catalogues bury the useful descriptor in free-text tags. */
const SEED_TAGS = [
  'phonk', 'drift phonk', 'memphis', 'trap', 'bass boost',
  'lofi', 'chillhop', 'ambient', 'study',
  'techno', 'house', 'dnb', 'breakcore', 'hyperpop',
  'rock', 'metal', 'punk', 'indie',
  'jazz', 'soul', 'funk', 'disco', 'rnb',
  'classical', 'piano', 'folk', 'reggae', 'afrobeat',
];

/**
 * Shorts are browsed by subject, not by genre. Music tags describe what a
 * track sounds like; a Shorts feed is about what it is *of*, so the two lists
 * share nothing.
 */
const SHORT_TOPICS = [
  'electronics', 'tech', 'devices', 'gadgets', 'pc build',
  'hacking', 'coding', 'ai', 'robotics', 'drones',
  'cars', 'motorbikes', 'racing', 'engineering',
  'gaming', 'speedrun', 'minecraft', 'fps',
  'football', 'basketball', 'skating', 'parkour', 'gym',
  'anime', 'memes', 'comedy', 'magic',
  'cooking', 'diy', 'science', 'space', 'nature', 'animals',
  'sneakers', 'fashion', 'travel', 'art',
];

const QUEUE_TARGET = 20;
/**
 * Candidates below this and the feed reaches for the network. Above it, the
 * local catalogue is wide enough for the diversity constraints to work with.
 */
const CANDIDATE_FLOOR = 60;
const QUEUE_LOW_WATER = 5;
/** Upper bound on the candidate pool held in memory. */
const QUEUE_CAP = 120;
/**
 * How far back a swipe can reach in Shorts. Anything older is dropped, so a
 * long session does not carry every Short it ever played. Five is about as far
 * as anyone reaches for the one they just scrolled past.
 */
const SHORTS_BACK_LIMIT = 5;
/**
 * How many liked tracks get folded back into a refill, and how long one has to
 * stay away before it qualifies.
 *
 * Repeat suppression is right for discovery and wrong for music: a feed that
 * never replays anything you liked is a feed of strangers. These bypass the
 * history exclusion deliberately — that is the whole point of them.
 */
const FAMILIAR_PER_REFILL = 2;
const FAMILIAR_COOLDOWN = 60;
/** Idle time before the player screen goes dark around the video. */
const AMBIENT_DELAY_MS = 25000;
/** Two taps closer together than this count as one double-tap. */
const DOUBLE_TAP_MS = 350;
/** The dimmest the window can go without being off. */
const DIM_FLOOR = 0.01;

/**
 * A short benchmark plus the engine version.
 *
 * The loop is arbitrary work; its only purpose is to give the same number a
 * desktop can be compared against, so "the CPU is slower" stops being an
 * assertion and becomes a ratio.
 */
function describeEngine(): string {
  const ua = navigator.userAgent || '';
  const chrome = /Chrome\/(\d+)/.exec(ua)?.[1] ?? 'unknown';
  const android = /Android (\d+(?:\.\d+)?)/.exec(ua)?.[1] ?? 'n/a';

  // Two runs, both reported. The first carries whatever the engine was doing
  // at the time — compiling this loop, and competing with any startup work
  // still in flight — which is why this number has moved between builds
  // without the hardware changing. The second runs warm and is the one to
  // compare across devices. The first is kept because every earlier reading
  // was measured that way, and silently changing what a number means is worse
  // than printing two.
  const bench = (): number => {
    const started = Date.now();
    let sink = 0;
    for (let i = 0; i < 2_000_000; i++) sink += i % 7;
    return sink < 0 ? -1 : Date.now() - started;
  };
  const cold = bench();
  const warm = bench();

  return (
    'Chromium ' + chrome + ' · Android ' + android +
    ' · CPU test ' + cold + 'ms (warm ' + warm + 'ms)'
  );
}
/**
 * Which WebView is rendering Dot, and whether there is another to switch to.
 *
 * The engine's age is the whole of the performance story — the player costs
 * seven seconds on the watch against one on a desktop over the same network,
 * and that is the thirty-fold gap in JavaScript speed, not the network. A newer
 * provider is the only lever that moves it, and whether the ROM will accept one
 * is not something the web layer can find out for itself.
 *
 * Nothing at all on a desktop or an ordinary browser, where the question does
 * not arise.
 */
function describeWebView(): string[] {
  const native = window.DotNative;
  // Not the Android shell at all — a desktop browser, where the question does
  // not arise and a line about it would be noise.
  if (!native) return [];

  // The web layer updates over the air and the shell does not, so the two drift
  // apart by design. Saying so is the point: this printed nothing at all when
  // the method was missing, which reads exactly like "no other provider found"
  // and is a different answer entirely.
  if (!native.webViewInfo) {
    return ['WebView provider: install the latest APK to see this — the Android shell here predates it.'];
  }

  let raw: string;
  try {
    raw = native.webViewInfo() ?? '';
  } catch {
    return ['WebView provider: the Android shell would not answer.'];
  }
  if (!raw) return ['WebView provider: the Android shell returned nothing.'];

  let info: { active?: string; version?: string; others?: string[] };
  try {
    info = JSON.parse(raw) as typeof info;
  } catch {
    return ['WebView provider: the answer from the shell did not parse — ' + raw.slice(0, 60)];
  }

  const lines = ['WebView provider: ' + (info.active ?? 'unknown') + ' ' + (info.version ?? '')];
  const others = info.others ?? [];
  lines.push(
    others.length > 0
      ? 'Also installed: ' + others.join(', ') + ' — a newer engine may be selectable.'
      : 'No other WebView provider is installed, so there is nothing to switch to.',
  );
  return lines;
}

/**
 * The development machine, baked in.
 *
 * Deliberately not something to be typed: the only device that would ever need
 * to enter it has a keyboard the size of a postage stamp, and it is always the
 * same machine. The port stays editable because that is one or two digits and
 * does change, and a full address is still accepted so a new IP on the laptop
 * does not mean building a new APK.
 */
const DEV_HOST = '192.168.88.128';
const DEV_PORT = '5174';

/** Bare port against the baked-in host; anything longer taken as an address. */
function devUrlFrom(value: string): string {
  const v = value.trim();
  if (!v) return 'http://' + DEV_HOST + ':' + DEV_PORT;
  if (/^[0-9]+$/.test(v)) return 'http://' + DEV_HOST + ':' + v;
  if (/^https?:\/\//.test(v)) return v;
  return 'http://' + v;
}

/** The port back out of a stored URL, or the whole thing if it is not ours. */
function portOf(url: string): string {
  if (!url) return '';
  const match = /^https?:\/\/([^:/]+)(?::([0-9]+))?/.exec(url.trim());
  if (!match) return url;
  return match[1] === DEV_HOST ? (match[2] ?? '') : url;
}

/**
 * How long to leave the device alone before preloading anything.
 *
 * Four seconds was not long enough by a wide margin. The watch reached the
 * fifth or sixth tick after startup and stopped answering — every launch,
 * which is what "it works on mobile data and not at home" turned out to mean,
 * since on mobile data the dev server is unreachable and the app it falls back
 * to is doing the same thing. Disabling the preload brought it straight back:
 * stuck at tick 3 for a hundred seconds, then ticking steadily to 19.
 *
 * Twenty-five seconds instead, and only while nothing else is going on. The
 * preload is worth four seconds off the first play and nothing at all if the
 * device is wedged when the play arrives.
 */
const CUE_DELAY_MS = 25000;

/**
 * How far back "already played" reaches when filling the feed.
 *
 * Every track ever played used to be excluded — the whole history, eight
 * hundred entries. The searches available on a given set of tags return much
 * the same videos each time, so the pool ran dry: a refill reported "104 found,
 * 92 already seen, 0 kept" and the feed said "Nothing here yet" on a working
 * connection with nine tenths of the day's quota unspent.
 *
 * Eighty is a few hours of listening, which is long enough not to hear a song
 * twice in a sitting and short enough that a modest catalogue still has
 * something to offer. Dislikes and unplayable tracks are excluded separately
 * and permanently; this is only about repetition.
 */
const RECENT_PLAY_WINDOW = 80;

function recentlyPlayed(): TrackId[] {
  return store.loadHistory().slice(-RECENT_PLAY_WINDOW);
}

/** How far the bar has to travel sideways before it is let go. */
const MINI_DISMISS_PX = 90;

/** Must match the rail width in the stylesheet. */
const RAIL_WIDTH = 62;
/** The only sections long enough to be worth hiding. */
const COLLAPSIBLE_SECTIONS = ['Music tags', 'Shorts topics'];

/**
 * Title cards for the wait while a track loads.
 *
 * Each name has a picture and a recording of the same line, prepared by hand
 * and matched by filename. A blank screen for seven seconds reads as broken;
 * the card and the voice read as a joke the app is in on.
 *
 * Shuffled per wait rather than escalating in order, so the same wait is not
 * the same card twice.
 */
const BUFFER_CARDS: readonly string[] = [
  'Second',
  'Long_Wait',
  'Hour',
  'Day',
  'Week',
  'Fortnight',
  'Month',
  'Season',
  'Year',
  'Century',
  'Lifetime',
  'Eternity',
];

/** Nothing shows for a start this quick; most of them are quicker than this. */
const BUFFER_DELAY_MS = 900;
/**
 * The pause after a line finishes before the next card.
 *
 * Deliberately not back to back: the recordings land better with a beat
 * between them, and a card that changes the instant the last one stops reads
 * as a glitch rather than a gag.
 */
const BUFFER_GAP_MS = 1500;
/** If a recording never reports finishing, move on anyway. */
const BUFFER_MAX_CARD_MS = 6000;

/** Injected by the Android shell. Absent in a browser. */
declare global {
  interface Window {
    DotNative?: {
      setKeepAwake(on: boolean): void;
      setBrightness(level: number): void;
      webViewInfo?(): string;
      setDevServer?(url: string): void;
      getDevServer?(): string;
      lastDevFailure?(): string;
      restartApp?(): void;
      setReturnTo?(tag: string): void;
      consumeReturnTo?(): string;
      clearDevFailure?(): void;
      probeDevServer?(url: string): void;
      probeStatus?(): string;
      appVersionCode?(): number;
      installSupported?(): boolean;
      canInstallApks?(): boolean;
      openInstallPermission?(): void;
      installUpdate?(url: string): void;
      installStatus?(): string;
    };
  }
}

type TabName = 'home' | 'search' | 'library' | 'settings';

/**
 * Only music and Shorts are surfaced. Ordinary videos are dropped rather than
 * given a tab: this is a music app, and a "Videos" section filled with
 * commentary and countdowns was noise.
 */
type Surface = Extract<TrackKind, 'music' | 'short'>;

export class App {
  private root: HTMLElement;
  private sources: MusicSource[];
  private youtube: YouTubeSource;
  private ytEngine: YouTubeEngine;
  private ytHost: HTMLElement;
  private player: Player;
  private model: TasteModel;
  private prefs: Prefs;
  private likes: Set<TrackId>;

  private queue: RankedTrack[] = [];
  private currentRanked: RankedTrack | null = null;
  /** The last few Shorts watched, so a downward swipe can return to them. */
  private shortsBack: RankedTrack[] = [];
  private refilling = false;

  private tabs = new Map<TabName, HTMLButtonElement>();
  private panes = new Map<TabName, HTMLElement>();
  private active: TabName = 'home';

  // Mini player
  private miniBar!: HTMLElement;
  private miniArt!: HTMLElement;
  private miniTitle!: HTMLElement;
  private miniArtist!: HTMLElement;
  private miniPlay!: HTMLButtonElement;
  private miniProgress!: HTMLElement;

  // Now Playing overlay
  private np!: HTMLElement;
  private npArt!: HTMLElement;
  private npArtImg!: HTMLElement;
  private npBackdrop!: HTMLElement;
  private npTitle!: HTMLElement;
  private npArtist!: HTMLElement;
  private npWhy!: HTMLElement;
  private npElapsed!: HTMLElement;
  private npTotal!: HTMLElement;
  private npFill!: HTMLElement;
  private npPlay!: HTMLButtonElement;
  private npLike!: HTMLButtonElement;
  private npStatus!: HTMLElement;
  private npTiming!: HTMLElement;
  private npLoading!: HTMLElement;
  private npBuffer!: HTMLImageElement;
  private captionTimer = 0;
  /** The order of cards for this wait, and how far through it we are. */
  private bufferOrder: string[] = [];
  private bufferAt = 0;
  private bufferVoice: HTMLAudioElement | null = null;
  private npSource!: HTMLElement;
  private npAdd!: HTMLButtonElement;

  // Home shelves
  private homeGreeting!: HTMLElement;

  /** Two surfaces. Anything classified as a plain video never reaches the UI. */
  private surface: Surface = 'music';
  private searchScope: 'all' | Surface = 'all';
  private searchResults: RankedTrack[] = [];
  private searchChannels!: HTMLElement;
  /** Set while a channel's uploads are on screen; null for a normal search. */
  private channelPool: RankedTrack[] | null = null;
  /**
   * True while the queue belongs to one channel. The feed refills itself from
   * trending and searches as it drains, which is right for the mixed feed and
   * wrong here — it diluted a channel back to variety within a couple of
   * tracks.
   */
  private channelLocked = false;
  private surfaceTabs = new Map<Surface, HTMLButtonElement>();
  private homeBody!: HTMLElement;
  private hidden: Set<TrackId> = store.loadHidden();
  /** Distinguishes "still loading" from "genuinely nothing" in the Shorts tab. */
  private shortsSearched = false;
  /** Rotates the top-up query so each refill reaches a different pool. */
  private topUpVariant = 0;
  /** Tags served this session, counted, to keep one from taking over. */
  private tagFatigue = new Map<string, number>();
  /** Consecutive early skips, with no like or completion between them. */
  private skipStreak = 0;
  /** True mid-drag on the scrubber, so progress updates do not fight it. */
  private seeking = false;
  /** Tags of the track playing before this one, for transition scoring. */
  private playingPrevTags: string[] = [];
  /** Set when a render was skipped because Now Playing was covering it. */
  private homeStale = false;
  /** Screens already constructed. The rest wait until they are opened. */
  private built = new Set<TabName>();
  /** Whether the shell is currently being asked to keep the screen on. */
  private keepingAwake = false;
  private ambientTimer = 0;
  private lastElapsed = '';
  private lastFillPct = -1;
  /**
   * Split timing for a track start. "app" is everything this code does before
   * the player is handed the video; "player" is from that hand-off until sound
   * starts. Which of the two is large decides whether there is anything left
   * worth optimising here or whether the wait is the network.
   */
  private startedAt = 0;
  /** Repaints the mirror status line while Settings is open. */
  private devTimer = 0;
  /** Defers the preload until the app has stopped being busy. */
  private cueTimer = 0;
  /** Width the Shorts stage is already set to; 0 when it is not in use. */
  private shortsStageWidth = 0;
  private handedOffAt = 0;
  private lastTiming = '';
  private timingLine?: HTMLElement;
  /** True while the double-tap has taken the screen down to its floor. */
  private dimmed = false;
  private lastTapAt = 0;
  /** Surfaces already auto-fetched once, so an empty one cannot loop. */
  private autoFilled = new Set<Surface>();
  /**
   * Where the last refill's candidates went. An empty feed has several
   * possible causes that look identical on screen — nothing fetched,
   * everything classified as a video, everything already seen, everything
   * blocked by the content filter — so the counts are kept and shown.
   */
  private lastFill = { fetched: 0, notMusic: 0, seen: 0, kept: 0 };

  private libraryList!: HTMLElement;
  private playlistList!: HTMLElement;
  private channelList!: HTMLElement;
  private statsBox!: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    // Built up front, detached, because Player needs it before the shell exists.
    // YouTube's terms require the embedded player to stay visible, so this ends
    // up mounted over the artwork rather than hidden off-screen.
    this.ytHost = el('div', 'yt-host');
    this.ytHost.hidden = true;

    this.youtube = new YouTubeSource();
    this.ytEngine = new YouTubeEngine(this.ytHost);
    this.sources = [this.youtube];
    this.player = new Player(this.ytEngine);
    this.model = store.loadModel();
    this.prefs = store.loadPrefs();
    this.likes = store.loadLikes();

    this.player.setVolume(this.prefs.volume);
    this.ytEngine.setCaptionsEnabled(this.prefs.captionsEnabled);
    this.player.addListener({
      onProgress: (cur, dur) => {
        // Belt and braces: if the playing event is missed, sound has clearly
        // started by the time progress is moving.
        if (this.startedAt > 0 && cur > 0) this.markStarted();
        this.renderProgress(cur, dur);
      },
      onStateChange: (playing) => {
        this.renderPlayState(playing);
        // markStarted is a no-op unless a start is actually being timed.
        if (playing) {
          this.markStarted();
          this.fitShortsStage();
        }
        this.updateKeepAwake(playing);
        this.scheduleAmbient();
        // Keyless playlists arrive as bare video ids, so the real title only
        // becomes available once the embedded player has loaded the video.
        if (playing) void this.captureYouTubeMetadata();
      },
      onPlayEvent: (event) => this.recordEvent(event),
      onError: (message) => {
        this.stopLoadingCaptions();
        const failed = this.player.track?.id;
        // Named, because a track being dropped is invisible otherwise: the wait
        // for every one that fails is charged to whichever track eventually
        // plays, and from outside it just looks like a slow start.
        console.info('dot: playback error — ' + message + ' — ' + (failed ?? 'unknown'));

        // A video whose owner has disabled embedding will never play, so it is
        // put away rather than offered again. The API says so up front and the
        // feed now filters on it, but everything fetched before that field was
        // read is still in the catalogue — and tapping one Short was costing
        // two failed loads before a playable one, with the whole wait charged
        // to the track that finally started.
        if (failed && message.indexOf('cannot be embedded') >= 0) {
          this.hidden = store.hideTrack(failed);
        }
        this.setStatus(message + ' — skipping');
      },
      onTrackChange: (track) => this.renderTrack(track),
    });
  }

  /** Milliseconds since the page began, for startup reporting. */
  private sinceBoot(): number {
    const boot = (window as unknown as { __dotBoot?: number }).__dotBoot;
    return boot ? Date.now() - boot : -1;
  }

  async start(): Promise<void> {
    console.info('dot: start() at +' + this.sinceBoot() + 'ms');
    // Anything that was loading when the app last died is put away before the
    // feed is built, so it cannot be offered again. One Short killed the
    // renderer four times in a row simply by being first in the list.
    for (const id of crashedTrackIds()) {
      if (!this.hidden.has(id as TrackId)) {
        this.hidden = store.hideTrack(id as TrackId);
        console.info('dot: hiding ' + id + ', the app died loading it');
      }
    }

    // Left by the shell before it restarted, and readable here even though the
    // restart changed origin — which localStorage would not have survived.
    const returnTo = window.DotNative?.consumeReturnTo?.() ?? '';

    // Onboarding is skipped when coming back to Development on purpose. A
    // restart onto a dev server lands on a fresh origin with no preferences, so
    // the way back would otherwise be behind the tag picker — exactly the wrong
    // place for it when the reason to be here is that something went wrong.
    if (this.prefs.musicTags.length === 0 && returnTo !== 'development') {
      this.renderOnboarding();
      return;
    }
    this.renderShell();
    console.info('dot: shell rendered at +' + this.sinceBoot() + 'ms');

    if (returnTo === 'development') {
      this.show('settings');
      // After the pane has been laid out; it is built lazily on first show.
      window.setTimeout(() => {
        document.getElementById('dot-development')?.scrollIntoView();
      }, 150);
      if (this.prefs.musicTags.length === 0) return;
    }
    // Kick the player off immediately, in parallel with fetching the feed, so
    // the two slow things overlap instead of queueing behind each other.
    this.ytEngine.prewarm();
    console.info('dot: prewarm issued at +' + this.sinceBoot() + 'ms');
    this.renderHome();
    this.renderLibrary();
    console.info('dot: first paint at +' + this.sinceBoot() + 'ms');
    await this.refillQueue();
    console.info('dot: feed ready at +' + this.sinceBoot() + 'ms');
    this.renderHome();
    console.info('dot: done at +' + this.sinceBoot() + 'ms');
  }

  /* ---------------------------------------------------------------- onboarding */

  private renderOnboarding(): void {
    clear(this.root);
    const wrap = el('div', 'onboard');

    const brand = el('div', 'brand');
    brand.appendChild(el('span', 'brand-dot'));
    brand.appendChild(el('span', 'brand-name', 'Dot'));
    wrap.appendChild(brand);

    wrap.appendChild(el('h1', 'onboard-title', "What do you\nwant to hear?"));
    wrap.appendChild(el('p', 'onboard-sub', 'Pick a few. Dot learns the rest from what you skip.'));

    const picked = new Set<string>();
    const grid = el('div', 'tile-grid');

    for (const tag of SEED_TAGS) {
      const tile = button('tile', tag);
      tile.style.backgroundColor = tintFor(tag);
      tile.addEventListener('click', () => {
        if (picked.has(tag)) {
          picked.delete(tag);
          tile.classList.remove('on');
        } else {
          picked.add(tag);
          tile.classList.add('on');
        }
        done.disabled = picked.size === 0;
        done.textContent = picked.size === 0 ? 'Pick at least one' : 'Start listening';
      });
      grid.appendChild(tile);
    }
    wrap.appendChild(grid);

    const done = button('primary', 'Pick at least one');
    done.disabled = true;
    done.addEventListener('click', () => {
      this.prefs.musicTags = Array.from(picked);
      store.savePrefs(this.prefs);
      // Cold start: picks become synthetic positive observations, so the first
      // queue is already shaped by them rather than random.
      this.model.seed(this.prefs.musicTags, []);
      store.saveModel(this.model);
      void this.start();
    });
    wrap.appendChild(done);

    this.root.appendChild(wrap);
  }

  /* --------------------------------------------------------------------- shell */

  private renderShell(): void {
    clear(this.root);

    const paneHost = el('div', 'panes');
    for (const name of ['home', 'search', 'library', 'settings'] as TabName[]) {
      const pane = el('section', 'pane');
      // Library styles its headings as settings groups; the others do not.
      if (name === 'library' || name === 'settings') pane.id = 'dot-' + name;
      pane.hidden = name !== this.active;
      this.panes.set(name, pane);
      paneHost.appendChild(pane);
    }
    this.root.appendChild(paneHost);

    // Only the visible screen is built. Search, Library and Settings between
    // them make close to a hundred chips, tiles, sliders and inputs, none of
    // which anyone is looking at on launch — and on a watch that is most of
    // the time between tapping the icon and seeing something.
    this.buildPane(this.active);

    this.buildMiniPlayer();
    this.buildTabBar();
    this.buildNowPlaying();

    if (!store.storageAvailable()) {
      this.setStatus('Storage is blocked — Dot will not remember this session.');
    }
  }

  private buildTabBar(): void {
    const nav = el('nav', 'tabbar');
    const items: Array<[TabName, string, string]> = [
      ['home', '⌂', 'Home'],
      ['search', '⌕', 'Search'],
      ['library', '≡', 'Library'],
      ['settings', '⚙', 'Settings'],
    ];
    for (const [name, glyph, label] of items) {
      const tab = button('tab');
      tab.appendChild(el('span', 'tab-icon', glyph));
      tab.appendChild(el('span', 'tab-label', label));
      if (name === this.active) tab.classList.add('on');
      tab.addEventListener('click', () => this.show(name));
      this.tabs.set(name, tab);
      nav.appendChild(tab);
    }
    this.root.appendChild(nav);
  }

  /**
   * Leaves channel mode and puts the mixed feed back.
   *
   * Clearing the flag is not enough on its own: the queue is still full of
   * that channel's uploads, and the Shorts top-up only runs when the queue is
   * nearly empty, so the feed would stay on that channel until it ran out.
   * The queue has to go with it.
   */
  private releaseChannel(): void {
    if (!this.channelLocked && !this.channelPool) return;
    this.channelLocked = false;
    this.channelPool = null;
    this.queue = [];
    void this.refillQueue().then(() => this.renderHome());
  }

  /** Builds a screen the first time it is needed, then leaves it alone. */
  private buildPane(name: TabName): void {
    if (this.built.has(name)) return;
    this.built.add(name);

    const host = this.panes.get(name);
    if (!host) return;

    if (name === 'home') this.buildHome(host);
    else if (name === 'search') this.buildSearch(host);
    else if (name === 'library') this.buildLibrary(host);
    else if (name === 'settings') {
      this.buildSettings(host);
      this.collapseSections(host);
    }
  }

  /**
   * Turns each heading in Settings into a collapsed section.
   *
   * Done as a pass over the finished screen rather than by restructuring every
   * builder: the headings already mark where one concern ends and the next
   * begins, so the grouping is there to be read rather than needing to be
   * declared again in eight places.
   */
  private collapseSections(host: HTMLElement): void {
    const nodes = Array.from(host.children) as HTMLElement[];
    let body: HTMLElement | null = null;

    for (const node of nodes) {
      const isHeading = node.tagName === 'H2' && node.classList.contains('shelf-title');
      if (!isHeading) {
        if (body) body.appendChild(node);
        continue;
      }

      // Only the tag pickers fold away. They are seventy-odd chips between
      // them and dwarf everything else on the screen; a toggle or a slider is
      // one row and is worse hidden behind a tap.
      const title = (node.textContent ?? '').trim();
      if (COLLAPSIBLE_SECTIONS.indexOf(title) < 0) {
        body = null;
        continue;
      }

      const toggle = button('section-toggle');
      toggle.appendChild(el('span', 'section-name', title));
      toggle.appendChild(el('span', 'section-mark', '+'));

      const panel = el('div', 'section-body');
      panel.hidden = true;

      host.insertBefore(toggle, node);
      host.insertBefore(panel, node);
      host.removeChild(node);

      toggle.addEventListener('click', () => {
        panel.hidden = !panel.hidden;
        toggle.classList.toggle('open', !panel.hidden);
        const mark = toggle.querySelector('.section-mark');
        if (mark) mark.textContent = panel.hidden ? '+' : '−';
      });
      body = panel;
    }
  }

  private show(name: TabName): void {
    // The channel view lives in Search; leaving it returns to the mixed feed.
    if (name !== 'search') this.releaseChannel();
    this.buildPane(name);
    this.active = name;
    for (const [key, pane] of this.panes) pane.hidden = key !== name;
    for (const [key, tab] of this.tabs) tab.classList.toggle('on', key === name);
    if (name === 'library') this.renderLibrary();
    // Both are read at build time, and Settings is built once — so without
    // this they keep showing whatever was true the first time it was opened.
    if (name === 'settings') {
      this.renderStats();
      this.paintTiming();
    }
  }

  /* ---------------------------------------------------------------------- home */

  private buildHome(host: HTMLElement): void {
    this.homeGreeting = el('h1', 'greeting', 'Good evening');
    host.appendChild(this.homeGreeting);

    // One pool, three views. Switching surfaces costs no API call, because
    // every candidate was already classified when it arrived.
    const seg = el('div', 'segment');
    const surfaces: Array<[Surface, string]> = [
      ['music', 'Music'],
      ['short', 'Shorts'],
    ];
    for (const [kind, label] of surfaces) {
      const tab = button('seg', label);
      if (kind === this.surface) tab.classList.add('on');
      tab.addEventListener('click', () => {
        // Switching surfaces is a return to the mixed feed too.
        this.releaseChannel();
        this.surface = kind;
        for (const [key, node] of this.surfaceTabs) node.classList.toggle('on', key === kind);
        this.renderHome();
        if (kind === 'short') void this.ensureShorts();
        // The other surface's first track is now the one most likely to be
        // tapped, so it is worth having ready — once the switch has finished
        // rendering. This was removed while hunting the Shorts crash, on the
        // theory that a second preload was responsible. It was not: the crash
        // happened just as readily with preloading disabled entirely.
        window.clearTimeout(this.cueTimer);
        this.cueTimer = window.setTimeout(() => this.cueAhead(), CUE_DELAY_MS);
      });
      this.surfaceTabs.set(kind, tab);
      seg.appendChild(tab);
    }
    host.appendChild(seg);

    this.homeBody = el('div');
    host.appendChild(this.homeBody);
  }

  /** The current surface's slice of the queue, minus anything hidden. */
  private queueFor(kind: Surface): RankedTrack[] {
    return this.queue.filter(
      (r) => (r.track.kind ?? 'music') === kind && !this.hidden.has(r.track.id),
    );
  }

  /**
   * Shorts run out faster than the other surfaces, because the free pool only
   * contains whatever happened to be vertical. When it empties, buy more —
   * the one deliberately paid call in the app, and only on demand.
   */
  private async ensureShorts(): Promise<void> {
    if (this.queueFor('short').length >= 3) return;
    // Shorts draw on their own list, falling back to the music tags so the
    // tab is not dead on arrival before anything is picked.
    const seeds = this.prefs.shortsTags.length > 0 ? this.prefs.shortsTags : this.prefs.musicTags;
    const bought = await this.youtube.topUpShorts(seeds, this.topUpVariant++);
    this.shortsSearched = true;
    if (bought.length === 0) {
      this.renderHome();
      return;
    }

    // History was never consulted here, so anything already watched got bought
    // and queued again — the main source of Shorts repeating. Pushing straight
    // onto the queue also skipped buildQueue, so none of the artist-cap or
    // tag-variety rules had ever applied to Shorts at all.
    const seen = new Set([...recentlyPlayed(), ...this.hidden]);

    // Re-rank only the Shorts. Feeding the whole queue through a ranking
    // capped at QUEUE_CAP let a big batch of Shorts crowd the music out
    // entirely, which is how the Music tab ended up empty after a Shorts
    // session. The two surfaces share a queue but must not evict each other.
    const others = this.queue.filter((r) => r.track.kind !== 'short');
    const shorts = buildQueue(
      [
        ...this.queue.filter((r) => r.track.kind === 'short').map((r) => r.track),
        ...bought.filter((t) => !seen.has(t.id)),
      ],
      this.model,
      {
        count: QUEUE_CAP - others.length,
        discovery: this.exploreRateNow(),
        exclude: seen,
        bucket: contextBucket(),
        fatigue: this.tagFatigue,
      },
    );
    this.queue = [...others, ...shorts];
    this.renderHome();
  }

  private greetingText(): string {
    const h = new Date().getHours();
    if (h < 6) return 'Late night';
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }

  private renderHome(): void {
    // Now Playing covers the whole screen, and most renders happen while a
    // track changes — which is exactly when it is open. Rebuilding twenty rows
    // and their images underneath it was pure cost on hardware with none to
    // spare, so it waits until there is something to see.
    if (this.np && this.np.classList.contains('open')) {
      this.homeStale = true;
      return;
    }
    this.homeStale = false;
    this.homeGreeting.textContent = this.greetingText();
    clear(this.homeBody);

    const items = this.queueFor(this.surface);

    if (this.surface === 'short') {
      this.homeBody.appendChild(el('h2', 'shelf-title', 'Shorts'));
      if (items.length === 0) {
        this.ensureSurface();
        this.homeBody.appendChild(
          el(
            'p',
            'empty',
            this.shortsSearched ? this.emptyTextFor() : 'Looking for Shorts…',
          ),
        );
        if (this.shortsSearched && !this.refilling) this.homeBody.appendChild(this.retryButton());
        return;
      }
      // A grid of portrait thumbnails; tapping one opens the vertical player.
      const grid = el('div', 'short-grid');
      for (const ranked of items.slice(0, 12)) grid.appendChild(this.shortCell(ranked));
      this.homeBody.appendChild(grid);
      return;
    }

    // A vertical list, not a horizontal shelf. Side-scrolling rails hide most
    // of the feed off-screen and fight the page's own scrolling, which is
    // worse on a small screen than it is on a phone.
    if (items.length === 0) this.ensureSurface();

    const endless = button('primary endless');
    endless.textContent = this.player.track ? 'Back to the endless mix' : 'Start the endless mix';
    endless.addEventListener('click', () => {
      this.channelLocked = false;
      void this.begin();
      this.openNowPlaying();
    });
    this.homeBody.appendChild(endless);

    this.homeBody.appendChild(el('h2', 'shelf-title', 'Made for you'));
    this.homeBody.appendChild(this.verticalList(items.slice(0, 20), this.emptyTextFor()));
    if (items.length === 0 && !this.refilling) {
      if (this.youtube.configured) {
        const f = this.lastFill;
        this.homeBody.appendChild(
          el(
            'p',
            'empty',
            'Last fetch: ' +
              f.fetched +
              ' found, ' +
              f.notMusic +
              ' not music, ' +
              f.seen +
              ' already seen, ' +
              this.youtube.lastHidden +
              ' filtered, ' +
              f.kept +
              ' kept.',
          ),
        );
        this.homeBody.appendChild(
          el(
            'p',
            'empty',
            'Quota today: ' +
              store.quotaUsed().toLocaleString() +
              ' of ' +
              store.YOUTUBE_DAILY_QUOTA.toLocaleString(),
          ),
        );
      }
      this.homeBody.appendChild(this.retryButton());
    }

    const recent = store
      .loadRecent()
      .filter((t) => (t.kind ?? 'music') === this.surface)
      .map((track) => ({ track, score: 0, explored: false }));
    if (recent.length > 0) {
      this.homeBody.appendChild(el('h2', 'shelf-title', 'Recently played'));
      this.homeBody.appendChild(this.verticalList(recent.slice(0, 15), ''));
    }
  }

  private verticalList(items: RankedTrack[], emptyText: string): HTMLElement {
    const list = el('div', 'list');
    if (items.length === 0) {
      if (emptyText) list.appendChild(el('p', 'empty', emptyText));
      return list;
    }
    for (const ranked of items) list.appendChild(this.row(ranked));
    return list;
  }

  /**
   * Why the surface is empty, not just that it is.
   *
   * The API reports quota exhaustion and key problems, and the feed was
   * swallowing all of it — only search ever showed these, so an empty Home
   * looked identical whether the key was out of quota, misconfigured, or the
   * search genuinely returned nothing.
   */
  private emptyTextFor(): string {
    if (!this.youtube.configured) return 'Add a YouTube key in Settings to fill this.';
    if (this.refilling) return 'Finding music…';

    const problem = this.youtube.lastKeyProblem;
    if (problem) return problem;

    const used = store.quotaUsed();
    if (used >= store.YOUTUBE_DAILY_QUOTA) {
      return 'Out of API quota for today. It resets at midnight Pacific.';
    }
    return 'Nothing here yet.';
  }

  /** Shown with an empty surface, since the automatic attempt only runs once. */
  private retryButton(): HTMLElement {
    const retry = button('toggle', 'Try again');
    retry.addEventListener('click', () => {
      this.allowRefetch();
      this.ensureSurface();
      this.renderHome();
    });
    return retry;
  }

  /**
   * Fetches when a surface has nothing to show.
   *
   * An empty tab used to be a dead end: the feed only refilled when the queue
   * ran low overall, so one surface could sit empty while the other was full.
   */
  private ensureSurface(): void {
    if (this.refilling) return;
    // Once per surface, and no more.
    //
    // This is called from renderHome when a surface is empty, and it finishes
    // by rendering again — so without a latch, a surface that stays empty
    // fetches, renders, finds itself still empty, and fetches again forever.
    // On Shorts each pass also spends a hundred quota units. The latch is
    // released by anything that could change the answer: new tags, a new key,
    // or the retry button.
    if (this.autoFilled.has(this.surface)) return;
    this.autoFilled.add(this.surface);

    if (this.surface === 'short') {
      void this.ensureShorts();
      return;
    }
    void this.refillQueue().then(() => this.renderHome());
  }

  /** Lets the empty surfaces try again — after new tags, a key, or a retry. */
  private allowRefetch(): void {
    this.autoFilled.clear();
  }

  /**
   * A Short as a portrait tile.
   *
   * Takes an optional pool for the same reason row() does: tapped from a
   * channel, what plays next should be the rest of that channel rather than the
   * mixed feed. Without it, browsing a channel's Shorts and tapping one quietly
   * dropped you back into the general queue.
   */
  private shortCell(ranked: RankedTrack, pool?: RankedTrack[]): HTMLElement {
    const cell = button('short-cell');
    const art = el('div', 'short-art');
    paintArt(art, ytThumb(ranked.track.artworkUrl, 'mq'), ranked.track.title, '▶', true);
    cell.appendChild(art);
    cell.appendChild(el('span', 'short-label', ranked.track.title));
    cell.addEventListener('click', () => {
      // A pool means a closed set, which also means it must not be topped up.
      this.channelLocked = pool !== undefined;
      if (pool) {
        // Everything after the one tapped, in the order the channel lists it.
        const at = pool.indexOf(ranked);
        this.queue = at >= 0 ? pool.slice(at + 1) : pool.filter((r) => r !== ranked);
      } else {
        // Back to the mixed feed.
        const at = this.queue.indexOf(ranked);
        if (at >= 0) this.queue.splice(at, 1);
      }
      void this.playTrack(ranked);
      this.openNowPlaying();
    });
    return cell;
  }

  /* -------------------------------------------------------------------- search */

  private buildSearch(host: HTMLElement): void {
    // No heading. The tab bar sits four rows below with this pane's name lit
    // up, so a title here repeats it at 35px plus its margin — on a screen with
    // 349 of them, where that is most of a row of results. Home keeps its
    // greeting because "Good evening" is not a label for the pane.

    const form = el('form', 'searchbar');
    const input = el('input', 'search-input');
    input.type = 'search';
    input.id = 'dot-search';
    input.placeholder = 'Song, tag, or @channel';
    input.autocomplete = 'off';
    form.appendChild(input);
    host.appendChild(form);

    const scopes: Array<['all' | Surface, string]> = [
      ['all', 'All'],
      ['music', 'Music'],
      ['short', 'Shorts'],
    ];
    const scopeBar = el('div', 'segment');
    const scopeButtons = new Map<string, HTMLButtonElement>();
    for (const [scope, label] of scopes) {
      const chip = button('seg', label);
      if (scope === this.searchScope) chip.classList.add('on');
      chip.addEventListener('click', () => {
        this.searchScope = scope;
        for (const [key, node] of scopeButtons) node.classList.toggle('on', key === scope);
        this.paintSearchResults(results);
      });
      scopeButtons.set(scope, chip);
      scopeBar.appendChild(chip);
    }
    host.appendChild(scopeBar);

    this.searchChannels = el('div', 'list');
    host.appendChild(this.searchChannels);

    const results = el('div', 'list');
    host.appendChild(results);

    const browseTitle = el('h2', 'shelf-title', 'Browse all');
    host.appendChild(browseTitle);

    const grid = el('div', 'tile-grid');
    for (const tag of SEED_TAGS) {
      const tile = button('tile', tag);
      tile.style.backgroundColor = tintFor(tag);
      tile.addEventListener('click', () => {
        input.value = tag;
        browseTitle.hidden = true;
        grid.hidden = true;
        void this.runSearch(tag, results);
      });
      grid.appendChild(tile);
    }
    host.appendChild(grid);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = input.value.trim();
      browseTitle.hidden = q.length > 0;
      grid.hidden = q.length > 0;
      if (!q) {
        clear(results);
        return;
      }
      void this.runSearch(q, results);
    });
  }

  private async runSearch(query: string, results: HTMLElement): Promise<void> {
    clear(results);
    results.appendChild(el('p', 'empty', 'Searching…'));

    // A leading @ means a channel. Listing a channel's own uploads costs three
    // quota units where searching costs a hundred, and returns the channel's
    // full catalogue in order rather than whatever a search surfaces.
    this.channelPool = null;
    const handle = query.trim();
    const found = handle.startsWith('@')
      ? await this.youtube.channelUploads(handle, 50)
      : await this.fromAllSources((s) => s.search(query, 40));
    clear(results);

    if (found.length === 0) {
      // A quota or key failure looks exactly like "no results" otherwise.
      const problem = this.youtube.lastKeyProblem;
      results.appendChild(el('p', 'empty', problem ?? 'Nothing found.'));
      return;
    }

    const bucket = contextBucket();
    const ranked = found
      .filter((track) => !this.hidden.has(track.id))
      .map((track) => ({ track, score: this.model.score(featurize(track, bucket)), explored: false }))
      .sort((a, b) => b.score - a.score);

    this.searchResults = ranked;
    this.paintSearchResults(results);
    void this.paintSearchChannels(found);
  }

  /**
   * Channels behind the results, listed above them.
   *
   * Derived from the videos already fetched rather than a separate channel
   * search, which would cost another hundred units; naming and illustrating
   * them costs one.
   */
  private async paintSearchChannels(found: Track[]): Promise<void> {
    clear(this.searchChannels);

    const ids: string[] = [];
    for (const track of found) {
      if (track.artistId && ids.indexOf(track.artistId) < 0) ids.push(track.artistId);
    }
    if (ids.length === 0) return;

    const channels = await this.youtube.channelsByIds(ids.slice(0, 8));
    if (channels.length === 0) return;

    clear(this.searchChannels);
    this.searchChannels.appendChild(el('h2', 'shelf-title', 'Channels'));
    for (const channel of channels) {
      this.searchChannels.appendChild(this.channelRow(channel));
    }
  }

  /** A channel: tap the row to browse it, tap the heart to follow it. */
  private channelRow(channel: Channel): HTMLElement {
    const row = el('div', 'row');

    const open = button('row-main row-open row-channel');
    const art = el('div', 'row-art row-avatar');
    paintArt(art, channel.thumbnailUrl, channel.title, '@', true);
    open.appendChild(art);

    const text = el('div', 'row-main');
    text.appendChild(el('span', 'row-title', channel.title));
    text.appendChild(el('span', 'row-sub', 'Channel'));
    open.appendChild(text);
    open.addEventListener('click', () => void this.openChannel(channel));
    row.appendChild(open);

    const follow = button('mini-btn', store.isFollowing(channel.id) ? '♥' : '♡', 'Follow channel');
    follow.classList.toggle('on', store.isFollowing(channel.id));
    follow.addEventListener('click', () => {
      const now = store.toggleChannel(channel);
      follow.textContent = now ? '♥' : '♡';
      follow.classList.toggle('on', now);
      this.renderLibrary();
    });
    row.appendChild(follow);

    return row;
  }

  /** Replaces the search results with everything one channel has uploaded. */
  private async openChannel(channel: Channel): Promise<void> {
    this.show('search');
    clear(this.searchChannels);
    this.searchChannels.appendChild(this.channelRow(channel));

    const results = this.searchChannels.nextElementSibling as HTMLElement | null;
    if (!results) return;
    clear(results);
    results.appendChild(el('p', 'empty', 'Loading ' + channel.title + '…'));

    const tracks = await this.youtube.channelUploadsById(channel.id, 50);
    const bucket = contextBucket();
    this.searchResults = tracks
      .filter((track) => !this.hidden.has(track.id))
      .map((track) => ({ track, score: this.model.score(featurize(track, bucket)), explored: false }));
    this.channelPool = this.searchResults;
    this.paintSearchResults(results);
  }

  /**
   * Draws whichever slice of the last search the scope chips are asking for.
   * Filtering here rather than at the request means switching scope is free —
   * one search already paid for every kind it returned.
   */
  private paintSearchResults(results: HTMLElement): void {
    clear(results);

    const shown =
      this.searchScope === 'all'
        ? this.searchResults
        : this.searchResults.filter((r) => (r.track.kind ?? 'music') === this.searchScope);
    // Only a channel view constrains what plays next. A normal search feeds
    // back into the mixed queue, which is what keeps Shorts varied.
    const pool = this.channelPool ? shown : undefined;

    if (shown.length === 0) {
      results.appendChild(
        el('p', 'empty', this.searchResults.length === 0 ? 'Nothing found.' : 'Nothing of that kind.'),
      );
      return;
    }

    // Shorts get the same grid of portrait tiles they get on the Shorts tab.
    // They were being listed as small landscape rows here, so a channel's
    // Shorts looked like a different feature from the same Shorts one tab over.
    if (this.searchScope === 'short') {
      const grid = el('div', 'short-grid');
      for (const item of shown) grid.appendChild(this.shortCell(item, pool));
      results.appendChild(grid);
      return;
    }

    for (const item of shown) results.appendChild(this.row(item, pool));
  }

  /**
   * `pool` is what should follow this track. Passed when the list being shown
   * is a closed set — one channel's uploads — so playing from it keeps the
   * feed inside that set instead of falling back to the mixed queue.
   */
  private row(ranked: RankedTrack, pool?: RankedTrack[]): HTMLElement {
    const row = button('row');

    const art = el('div', 'row-art');
    paintArt(art, ytThumb(ranked.track.artworkUrl, 'default'), ranked.track.title, '♪', true);
    row.appendChild(art);

    const main = el('div', 'row-main');
    main.appendChild(el('span', 'row-title', ranked.track.title));

    const length = ranked.track.duration > 0 ? ' · ' + formatTime(ranked.track.duration) : '';
    main.appendChild(el('span', 'row-sub', ranked.track.artist + length));
    row.appendChild(main);

    row.addEventListener('click', () => {
      // A pool means a closed set, which also means it must not be topped up.
      this.channelLocked = pool !== undefined;
      if (pool) {
        // Everything after the one tapped, in the order the channel lists it.
        const at = pool.indexOf(ranked);
        this.queue = at >= 0 ? pool.slice(at + 1) : pool.filter((r) => r !== ranked);
      }
      void this.playTrack(ranked);
      this.openNowPlaying();
    });
    return row;
  }

  /* ------------------------------------------------------------------- library */

  /** Things you have collected: liked tracks and the playlists you follow. */
  private buildLibrary(host: HTMLElement): void {

    this.libraryList = el('div', 'list');
    host.appendChild(this.libraryList);

    host.appendChild(el('h2', 'shelf-title', 'Following'));
    this.channelList = el('div', 'list');
    host.appendChild(this.channelList);

    host.appendChild(el('h2', 'shelf-title', 'Playlists'));

    const create = button('primary', 'New playlist');
    create.addEventListener('click', () => {
      const name = window.prompt('Name this playlist');
      if (name === null) return;
      store.createPlaylist(name);
      this.renderPlaylists();
    });
    host.appendChild(create);

    this.playlistList = el('div', 'list');
    host.appendChild(this.playlistList);
  }

  /**
   * Playlists the user built. Tapping one plays it in order, replacing the
   * queue rather than appending to it — choosing a playlist is an explicit
   * "play this now", not a suggestion to fold into the feed.
   */
  private renderPlaylists(): void {
    if (!this.playlistList) return;
    clear(this.playlistList);

    const playlists = store.loadPlaylists();
    if (playlists.length === 0) {
      this.playlistList.appendChild(
        el('p', 'empty', 'No playlists yet. Add tracks from the player.'),
      );
      return;
    }

    for (const playlist of playlists) {
      const row = el('div', 'row');

      const art = el('div', 'row-art', '≡');
      art.style.backgroundColor = tintFor(playlist.name);
      row.appendChild(art);

      const open = button('row-main row-open');
      open.appendChild(el('span', 'row-title', playlist.name));
      open.appendChild(
        el(
          'span',
          'row-sub',
          playlist.tracks.length + (playlist.tracks.length === 1 ? ' track' : ' tracks'),
        ),
      );
      open.addEventListener('click', () => void this.playPlaylist(playlist.id));
      row.appendChild(open);

      const remove = button('mini-btn', '✕', 'Delete playlist');
      remove.addEventListener('click', () => {
        if (!window.confirm('Delete "' + playlist.name + '"?')) return;
        store.deletePlaylist(playlist.id);
        this.renderPlaylists();
      });
      row.appendChild(remove);

      this.playlistList.appendChild(row);
    }
  }

  private renderChannels(): void {
    if (!this.channelList) return;
    clear(this.channelList);

    const channels = store.loadChannels();
    if (channels.length === 0) {
      this.channelList.appendChild(
        el('p', 'empty', 'No channels yet. Follow one from search.'),
      );
      return;
    }
    for (const channel of channels) this.channelList.appendChild(this.channelRow(channel));
  }

  private async playPlaylist(id: string): Promise<void> {
    this.channelLocked = false;
    const playlist = store.loadPlaylists().find((pl) => pl.id === id);
    if (!playlist || playlist.tracks.length === 0) return;

    const bucket = contextBucket();
    this.queue = playlist.tracks.map((track) => ({
      track,
      score: this.model.score(featurize(track, bucket)),
      explored: false,
    }));

    const first = this.queue.shift();
    if (!first) return;
    await this.playTrack(first);
    this.openNowPlaying();
  }

  /** Everything configurable. Separated from Library so neither screen is
   *  a long scroll of unrelated concerns. */
  /**
   * Points the watch at a development machine instead of its own copy.
   *
   * This device has no USB, no developer options and no browser, so there is
   * otherwise no way to try a change on it without building an APK or waiting
   * for an over-the-air update. Loading the app from a laptop on the same WiFi
   * gives a save-and-reload loop, and — because it is then a plain HTTP page
   * rather than one served from appassets — lets the app reach that machine at
   * all, which is what the screen mirroring needs.
   *
   * Only appears inside the Android shell, and only when that shell is new
   * enough to honour it.
   */
  /**
   * What went wrong last time, if anything did.
   *
   * On the installed copy this is the only record there is: the mirror cannot
   * reach it, and a renderer killed for running out of memory takes its console
   * with it. Shown rather than merely stored, because the person holding the
   * watch is the only one who can see it.
   */
  private buildCrashLog(host: HTMLElement): void {
    const crashes = recentCrashes();
    if (crashes.length === 0) return;

    host.appendChild(el('h2', 'shelf-title', 'Problems'));
    for (const crash of crashes.slice(-4).reverse()) {
      const when = new Date(crash.at);
      const stamp =
        String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0');
      host.appendChild(el('p', 'muted', stamp + ' — ' + crash.doing + ' — ' + crash.how));
    }

    const clear = button('toggle', 'Clear these');
    clear.addEventListener('click', () => {
      clearCrashes();
      this.show('settings');
    });
    host.appendChild(clear);
  }

  private buildDevServer(host: HTMLElement): void {
    const native = window.DotNative;
    const mirror = mirrorStatus();
    // Nothing to say in a plain browser that is not mirroring either.
    if (!native?.setDevServer && !mirror.active) return;

    const heading = el('h2', 'shelf-title', 'Development');
    heading.id = 'dot-development';
    host.appendChild(heading);

    // The first question is always "is it even loading from the laptop", and
    // until now the only way to answer it was to guess from how the app felt.
    const from = location.protocol === 'http:' ? location.origin : 'the installed copy';
    host.appendChild(el('p', 'muted', 'Running from: ' + from));

    // A load that failed used to revert in silence, which looks identical to
    // never having been asked. Say what went wrong and when.
    const failure = native?.lastDevFailure?.() ?? '';
    if (failure) {
      const note = el('p', 'muted', 'Last attempt failed: ' + failure);
      host.appendChild(note);
      const dismiss = button('toggle', 'Clear that');
      dismiss.addEventListener('click', () => {
        native?.clearDevFailure?.();
        note.textContent = '';
        dismiss.hidden = true;
      });
      host.appendChild(dismiss);
    }

    // One switch for the whole arrangement, not just for the mirror.
    //
    // Stopping the mirror alone still left the app being fetched from a laptop
    // over wifi, and still left it reloading itself whenever that laptop
    // rebuilt — which is most of what made it feel worse at home than it did
    // out on mobile data, where the laptop is unreachable and the watch quietly
    // runs its own copy. Off now means exactly that copy.
    const on = mirrorEnabled() && location.protocol === 'http:';
    const toggle = button('toggle', on ? 'Mirroring: on' : 'Mirroring: off');
    toggle.classList.toggle('on', on);
    host.appendChild(toggle);
    host.appendChild(
      el(
        'p',
        'muted',
        on
          ? 'Running from this machine, and reporting to it. Turning this off returns to the copy installed on the watch.'
          : 'Running the installed copy. Turning this on loads Dot from ' + DEV_HOST + ' and reports back.',
      ),
    );

    toggle.addEventListener('click', () => {
      if (!native?.setDevServer) {
        // No shell to restart into: the mirror is all there is to switch.
        setMirrorEnabled(!mirrorEnabled());
        this.show('settings');
        return;
      }
      setMirrorEnabled(!on);
      // Empty address means the packaged app; a real one means this machine.
      native.setDevServer(on ? '' : devUrlFrom(portOf(native.getDevServer?.() ?? '') || DEV_PORT));
      native.setReturnTo?.('development');
      toggle.textContent = on ? 'Switching to the installed copy…' : 'Loading from ' + DEV_HOST + '…';
      window.setTimeout(() => native.restartApp?.(), 250);
    });

    const live = el('p', 'muted', '');
    host.appendChild(live);
    const paint = (): void => {
      const m = mirrorStatus();
      if (!mirrorEnabled()) {
        live.textContent = 'Switched off. Nothing is being sent.';
        return;
      }
      if (!m.active) {
        live.textContent = 'Idle — only runs when Dot is loaded from a dev server.';
        return;
      }
      // The button above already says the word; repeating it here read as two
      // separate settings rather than a switch and its state.
      const ago = m.lastOkAt ? Math.round((Date.now() - m.lastOkAt) / 1000) : null;
      live.textContent =
        ago === null
          ? 'No reply yet from ' + m.relay + (m.lastError ? ' — ' + m.lastError : '')
          : m.sent + ' sent, last ' + ago + 's ago → ' + m.relay;
    };
    paint();
    // Cleared whenever Settings is rebuilt, so it cannot outlive the element.
    window.clearInterval(this.devTimer);
    this.devTimer = window.setInterval(paint, 1000);

    if (!native?.setDevServer || !native.getDevServer) return;

    host.appendChild(
      el('p', 'muted', 'Load Dot from ' + DEV_HOST + ' instead of from the watch.'),
    );
    // Worth saying plainly, because the symptom is alarming and looks like data
    // loss: a different address is a different origin, and localStorage does
    // not cross one. The copy on the laptop starts with no tags, no key and no
    // taste model. Nothing is gone — it is still there on the installed copy,
    // which "Use the installed copy" goes back to.
    host.appendChild(
      el(
        'p',
        'muted',
        'That copy keeps its own tags, key and taste model — yours are untouched and come back when you do.',
      ),
    );

    // Only the port. Typing an address on a watch keyboard is punishing enough
    // that it was the thing most likely to stop this being used at all, and the
    // machine is always the same one. A full address is still accepted, so a
    // new IP does not mean a new APK.
    const field = el('input', 'slider') as HTMLInputElement;
    field.type = 'text';
    field.inputMode = 'numeric';
    field.placeholder = DEV_PORT;
    field.value = portOf(native.getDevServer() ?? '');
    host.appendChild(field);

    const state = el('p', 'muted', '');
    const target = (): string => devUrlFrom(field.value || DEV_PORT);

    // Answers "is that reachable from here" before committing to a restart. The
    // page cannot ask this itself — from appassets it is an HTTPS page and a
    // plain-HTTP request on the LAN is blocked as mixed content — so the shell
    // asks on its behalf.
    const test = button('toggle', 'Test connection');
    test.addEventListener('click', () => {
      const url = target();
      state.textContent = 'Testing ' + url + ' …';
      native.probeDevServer?.(url);
      let waited = 0;
      const poll = window.setInterval(() => {
        const result = native.probeStatus?.() ?? '';
        waited += 300;
        if (!result && waited < 6000) return;
        window.clearInterval(poll);
        if (!result) state.textContent = 'No answer after 6s — treat that as unreachable.';
        else if (result.indexOf('ok') === 0) state.textContent = 'Reachable. Save and reopen Dot to use it.';
        else state.textContent = 'Could not reach it: ' + result;
      }, 300);
    });
    host.appendChild(test);

    const save = button('toggle', 'Save and restart');
    save.addEventListener('click', () => {
      const url = target();
      native.setDevServer?.(url);
      // Saved before the restart is asked for, and read back in onCreate, so
      // the ordering that used to lose the setting cannot happen.
      native.setReturnTo?.('development');
      state.textContent = 'Saved ' + url + '. Restarting…';
      if (native.restartApp) window.setTimeout(() => native.restartApp?.(), 250);
      else state.textContent = 'Saved ' + url + '. Close and reopen Dot.';
    });
    host.appendChild(save);

    // No separate "use the installed copy" button: the switch above is that,
    // and two controls for one decision is how someone ends up with mirroring
    // off and the app still being served from a laptop.

    host.appendChild(state);
  }

  private buildSettings(host: HTMLElement): void {

    // Above the collapsed sections, so it is readable without opening
    // anything. This is the number that says whether a slow start is this
    // app's fault or the network's.
    this.timingLine = el('p', 'muted');
    this.paintTiming();
    host.appendChild(this.timingLine);

    // The engine version decides how fast the player's own JavaScript runs,
    // and that is where the time goes on this device. A frozen WebView from
    // the ROM is years behind on JS performance.
    host.appendChild(el('p', 'muted', describeEngine()));
    for (const line of describeWebView()) host.appendChild(el('p', 'muted', line));

    host.appendChild(el('h2', 'shelf-title', 'Discovery'));
    host.appendChild(
      el('p', 'muted', 'How often Dot takes a risk instead of playing it safe.'),
    );

    const slider = el('input', 'slider');
    slider.type = 'range';
    slider.id = 'dot-discovery';
    slider.min = '0';
    slider.max = '60';
    slider.step = '5';
    slider.value = String(Math.round(this.prefs.discovery * 100));

    const readout = el('p', 'readout', slider.value + '% exploring');
    slider.addEventListener('input', () => {
      readout.textContent = slider.value + '% exploring';
      this.prefs.discovery = Number(slider.value) / 100;
      store.savePrefs(this.prefs);
    });
    host.appendChild(slider);
    host.appendChild(readout);

    this.buildTagPicker(
      host,
      'Music tags',
      'Genres the Music feed is built from. Long mixes are included: each '
        + 'track start costs a few seconds inside the player, so one long '
        + 'upload interrupts far less than twenty short ones.',
      this.prefs.musicTags,
      SEED_TAGS,
    );
    this.buildTagPicker(
      host,
      'Shorts topics',
      'Subjects, not genres. Leave empty and Shorts will follow your music tags instead.',
      this.prefs.shortsTags,
      SHORT_TOPICS,
    );

    host.appendChild(el('h2', 'shelf-title', 'Content'));
    host.appendChild(
      el(
        'p',
        'muted',
        'Scores every track for how childish it looks and drops the ones that ' +
          'cross the line. Remixes, phonk edits and slowed/reverb uploads count ' +
          'as music and survive. Strict catches more, and false positives with it.',
      ),
    );

    const levels: Array<['off' | 'normal' | 'strict', string]> = [
      ['off', 'Off'],
      ['normal', 'Normal'],
      ['strict', 'Strict'],
    ];
    const segment = el('div', 'segment');
    const segButtons = new Map<string, HTMLButtonElement>();

    for (const [level, label] of levels) {
      const seg = button('seg', label);
      if (this.prefs.filterLevel === level) seg.classList.add('on');
      seg.addEventListener('click', () => {
        this.prefs.filterLevel = level;
        store.savePrefs(this.prefs);
        for (const [key, node] of segButtons) node.classList.toggle('on', key === level);
        // Cached results were filtered at the old level, so start clean.
        void this.refillQueue().then(() => this.renderHome());
      });
      segButtons.set(level, seg);
      segment.appendChild(seg);
    }
    host.appendChild(segment);

    host.appendChild(el('h2', 'shelf-title', 'Screen'));
    host.appendChild(
      el(
        'p',
        'muted',
        'Brightness while Dot is open. Double-tap the player to drop to the ' +
          'dimmest, and again to come back here. Leave at System to leave it alone.',
      ),
    );

    const brightness = el('input', 'slider');
    brightness.type = 'range';
    brightness.id = 'dot-brightness';
    brightness.min = '0';
    brightness.max = '100';
    brightness.step = '5';
    // 0 on the slider means "hand it back to the system".
    brightness.value = String(
      this.prefs.screenBrightness < 0 ? 0 : Math.round(this.prefs.screenBrightness * 100),
    );

    const brightnessRead = el('p', 'readout', '');
    const paintBrightness = (): void => {
      brightnessRead.textContent =
        this.prefs.screenBrightness < 0 ? 'System' : Math.round(this.prefs.screenBrightness * 100) + '%';
    };
    paintBrightness();
    brightness.addEventListener('input', () => {
      const pct = Number(brightness.value);
      this.prefs.screenBrightness = pct === 0 ? -1 : pct / 100;
      store.savePrefs(this.prefs);
      this.dimmed = false;
      this.applyBrightness();
      paintBrightness();
    });
    host.appendChild(brightness);
    host.appendChild(brightnessRead);

    const awakeToggle = button('toggle');
    const paintAwake = (): void => {
      awakeToggle.textContent = this.prefs.keepScreenOn
        ? 'Screen stays on for music'
        : 'Screen may sleep during music';
      awakeToggle.classList.toggle('on', this.prefs.keepScreenOn);
    };
    paintAwake();
    awakeToggle.addEventListener('click', () => {
      this.prefs.keepScreenOn = !this.prefs.keepScreenOn;
      store.savePrefs(this.prefs);
      paintAwake();
      this.updateKeepAwake(this.player.playing);
    });
    host.appendChild(
      el(
        'p',
        'muted',
        'Keeping the screen on stops a track being cut off when the watch ' +
          'sleeps, and is the largest battery cost in the app. With it on, the ' +
          'player screen goes dark around the video after half a minute.',
      ),
    );
    host.appendChild(awakeToggle);

    const capToggle = button('toggle');
    const paintCaptions = (): void => {
      capToggle.textContent = this.prefs.captionsEnabled ? 'Subtitles on' : 'Subtitles off';
      capToggle.classList.toggle('on', this.prefs.captionsEnabled);
    };
    paintCaptions();
    capToggle.addEventListener('click', () => {
      this.prefs.captionsEnabled = !this.prefs.captionsEnabled;
      store.savePrefs(this.prefs);
      this.ytEngine.setCaptionsEnabled(this.prefs.captionsEnabled);
      paintCaptions();
    });
    host.appendChild(capToggle);

    host.appendChild(el('h2', 'shelf-title', 'YouTube search'));
    host.appendChild(
      el(
        'p',
        'muted',
        'A YouTube Data API v3 key searches all of YouTube from inside Dot. ' +
          'Free tier is 10,000 units a day and a search costs 100, so about a ' +
          'hundred searches — the feed leans on trending, which costs 1. ' +
          'Without a key, search only covers tracks Dot has already played.',
      ),
    );

    const keyField = el('input', 'search-input key-input');
    keyField.type = 'text';
    keyField.id = 'dot-yt-key';
    keyField.placeholder = 'YouTube Data API v3 key';
    keyField.autocomplete = 'off';
    keyField.spellcheck = false;
    keyField.value = this.prefs.youtubeApiKey;

    const keyState = el('p', 'readout', this.youtube.configured ? 'Connected' : 'Not connected');
    keyField.addEventListener('change', () => {
      this.prefs.youtubeApiKey = keyField.value.trim();
      store.savePrefs(this.prefs);
      if (!this.youtube.configured) {
        keyState.textContent = 'Not connected';
        return;
      }
      // One unit to find out now, rather than a key that silently returns
      // nothing because the API was never enabled on its project.
      keyState.textContent = 'Checking…';
      void this.youtube.verifyKey().then((problem) => {
        keyState.textContent = problem ?? 'Connected — search is on';
        // Re-pull the feed so YouTube results appear without a reload.
        if (!problem) {
          this.allowRefetch();
          void this.refillQueue().then(() => this.renderHome());
        }
      });
    });
    host.appendChild(keyField);
    host.appendChild(keyState);

    host.appendChild(el('h2', 'shelf-title', 'Updates'));
    host.appendChild(
      el(
        'p',
        'muted',
        'Dot can fetch a new build itself. Most changes arrive that way; ones ' +
          'that touch the Android side come as an app update, offered below ' +
          'when there is one. Leave the box empty to use the official build.',
      ),
    );

    const versionLine = el('div', 'stat');
    versionLine.appendChild(el('span', 'stat-k', 'Running'));
    versionLine.appendChild(
      el('span', 'stat-v', runningVersion() + (isRunningDownloaded() ? ' (downloaded)' : '')),
    );
    host.appendChild(versionLine);

    const urlField = el('input', 'search-input key-input');
    urlField.type = 'text';
    urlField.id = 'dot-update-url';
    urlField.placeholder = updateUrl();
    urlField.autocomplete = 'off';
    urlField.spellcheck = false;
    urlField.value = usingDefaultUpdateUrl() ? '' : updateUrl();
    urlField.addEventListener('change', () => setUpdateUrl(urlField.value));
    host.appendChild(urlField);

    const updateState = el('p', 'readout', '');
    const checkBtn = button('primary', 'Check for updates');
    checkBtn.addEventListener('click', () => {
      setUpdateUrl(urlField.value);
      checkBtn.disabled = true;
      updateState.textContent = 'Checking…';
      void checkForUpdate().then((status) => {
        updateState.textContent = status.message;
        checkBtn.disabled = false;
        if (status.available) {
          // A downloaded build only takes effect on the next launch, since the
          // running one is already evaluated.
          reloadBtn.hidden = false;
        }
        // The shell and the bundle move independently, so this is offered on
        // its own terms rather than as part of the bundle result.
        // Hidden outright when the shell cannot install one, rather than shown
        // and then failing: there would be nothing the person could do about
        // it, and a button that leads to a settings screen with no switch on it
        // is worse than no button.
        if (status.apkUrl && window.DotNative?.installSupported?.()) {
          installBtn.hidden = false;
          installBtn.textContent = 'Install app update (' + status.apkVersion + ')';
          pendingApk = status.apkUrl;
        } else if (status.apkUrl) {
          updateState.textContent =
            status.message + ' The app update has to be installed by hand.';
        }
      });
    });
    host.appendChild(checkBtn);

    // Everything below is the app update, which is a different thing from a new
    // bundle: it replaces the Android shell, so it goes through the system
    // installer and needs a permission the app cannot grant itself.
    let pendingApk = '';
    const installBtn = button('primary', 'Install app update');
    installBtn.hidden = true;
    installBtn.addEventListener('click', () => {
      const native = window.DotNative;
      if (!pendingApk || !native?.installUpdate) return;

      // Asked before the download rather than after, so a refusal costs
      // nothing and the explanation arrives while it still makes sense.
      if (native.canInstallApks && !native.canInstallApks()) {
        updateState.textContent =
          'Android needs permission to install apps from Dot. Turn it on, then tap this again.';
        native.openInstallPermission?.();
        return;
      }

      installBtn.disabled = true;
      updateState.textContent = 'Downloading the app update…';
      native.installUpdate(pendingApk);

      const poll = window.setInterval(() => {
        const state = native.installStatus?.() ?? '';
        if (state === 'downloading' || !state) return;
        window.clearInterval(poll);
        installBtn.disabled = false;
        updateState.textContent =
          state === 'ready'
            ? 'Downloaded. Confirm the install when Android asks.'
            : 'Could not install: ' + state.replace(/^fail /, '');
      }, 500);
    });
    host.appendChild(installBtn);

    const reloadBtn = button('toggle', 'Restart to apply');
    reloadBtn.hidden = true;
    reloadBtn.addEventListener('click', () => window.location.reload());
    host.appendChild(reloadBtn);
    host.appendChild(updateState);

    host.appendChild(el('h2', 'shelf-title', 'Taste model'));
    this.statsBox = el('div', 'stats');
    host.appendChild(this.statsBox);

    this.buildCrashLog(host);
    this.buildDevServer(host);

    const reset = button('danger', 'Forget everything');
    reset.addEventListener('click', () => {
      if (!window.confirm('Erase your taste model, likes and history?')) return;
      store.clearAll();
      window.location.reload();
    });
    host.appendChild(reset);
  }

  /**
   * A tag picker bound to one list. Mutates the array in place, so the caller
   * passes whichever of the prefs lists this picker owns.
   */
  private buildTagPicker(
    host: HTMLElement,
    title: string,
    description: string,
    list: string[],
    options: readonly string[],
  ): void {
    host.appendChild(el('h2', 'shelf-title', title));
    host.appendChild(el('p', 'muted', description));

    const grid = el('div', 'chip-grid');
    for (const tag of options) {
      const chip = button('chip', tag);
      chip.style.backgroundColor = tintFor(tag);
      if (list.indexOf(tag) >= 0) chip.classList.add('on');
      chip.addEventListener('click', () => {
        const at = list.indexOf(tag);
        if (at >= 0) {
          list.splice(at, 1);
          chip.classList.remove('on');
        } else {
          list.push(tag);
          chip.classList.add('on');
          // Adding a tag nudges the model rather than resetting what it knows.
          this.model.seed([tag], [], 2, 0.5);
          store.saveModel(this.model);
        }
        store.savePrefs(this.prefs);
        this.allowRefetch();
        void this.refillQueue().then(() => this.renderHome());
      });
      grid.appendChild(chip);
    }
    host.appendChild(grid);
  }

  private renderLibrary(): void {
    // Reachable from a follow button in Search, before Library has been built.
    if (!this.libraryList) return;
    clear(this.libraryList);

    const liked = store.loadLikedTracks();
    const likedRow = button('row row-feature');
    const art = el('div', 'row-art row-art-liked', '♥');
    likedRow.appendChild(art);
    const main = el('div', 'row-main');
    main.appendChild(el('span', 'row-title', 'Liked songs'));
    main.appendChild(el('span', 'row-sub', liked.length + (liked.length === 1 ? ' track' : ' tracks')));
    likedRow.appendChild(main);
    likedRow.addEventListener('click', () => {
      if (liked.length === 0) return;
      void this.playTrack({ track: liked[0]!, score: 1, explored: false });
      this.openNowPlaying();
    });
    this.libraryList.appendChild(likedRow);

    for (const track of liked.slice(0, 20)) {
      this.libraryList.appendChild(this.row({ track, score: 0, explored: false }));
    }

    if (this.statsBox) this.renderStats();
    this.renderChannels();
    this.renderPlaylists();
  }

  private renderStats(): void {
    if (!this.statsBox) return;
    clear(this.statsBox);
    const events = store.loadEvents();
    const epsilon = exploreRate(this.prefs.discovery, this.model.n);

    const add = (label: string, value: string): void => {
      const row = el('div', 'stat');
      row.appendChild(el('span', 'stat-k', label));
      row.appendChild(el('span', 'stat-v', value));
      this.statsBox.appendChild(row);
    };

    add('Tracks heard', String(events.length));
    add('Model updates', String(this.model.n));
    add('Liked', String(this.likes.size));
    add('Currently exploring', Math.round(epsilon * 100) + '%');
    if (this.lastTiming) add('Last track start', this.lastTiming);
    add('Player ready at launch', this.ytEngine.isWarm() ? 'yes' : 'no');

    // Only meaningful with a key; the playlist path costs nothing at all.
    if (this.youtube.configured) {
      const used = store.quotaUsed();
      add(
        'API quota today',
        used.toLocaleString() + ' / ' + store.YOUTUBE_DAILY_QUOTA.toLocaleString(),
      );
      add('Searches left', String(Math.max(0, Math.floor((store.YOUTUBE_DAILY_QUOTA - used) / 100))));
    }
  }

  /* -------------------------------------------------------------- mini player */

  private buildMiniPlayer(): void {
    this.miniBar = el('div', 'mini');
    this.miniBar.hidden = true;

    const tap = button('mini-tap');
    this.miniArt = el('div', 'mini-art');
    tap.appendChild(this.miniArt);

    const text = el('div', 'mini-text');
    this.miniTitle = el('span', 'mini-title', '');
    this.miniArtist = el('span', 'mini-artist', '');
    text.appendChild(this.miniTitle);
    text.appendChild(this.miniArtist);
    tap.appendChild(text);
    tap.addEventListener('click', () => this.openNowPlaying());
    this.miniBar.appendChild(tap);

    this.miniPlay = button('mini-btn', '▶', 'Play or pause');
    this.miniPlay.addEventListener('click', (e) => {
      e.stopPropagation();
      this.player.toggle();
    });
    this.miniBar.appendChild(this.miniPlay);

    const next = button('mini-btn', '⏭', 'Next track');
    next.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.next('skipped');
    });
    this.miniBar.appendChild(next);

    const track = el('div', 'mini-track');
    this.miniProgress = el('div', 'mini-fill');
    track.appendChild(this.miniProgress);
    this.miniBar.appendChild(track);

    this.root.appendChild(this.miniBar);
  }

  /* -------------------------------------------------------------- now playing */

  private buildNowPlaying(): void {
    this.np = el('div', 'np');

    const head = el('div', 'np-head');
    const down = button('np-icon', '⌄', 'Close');
    down.addEventListener('click', () => this.closeNowPlaying());
    head.appendChild(down);
    this.npSource = el('span', 'np-source', '');
    head.appendChild(this.npSource);
    head.appendChild(el('span', 'np-icon np-spacer', ''));
    this.np.appendChild(head);

    this.npArt = el('div', 'np-art');
    // Artwork lives in its own child, because paintArt() replaces textContent
    // and would otherwise wipe out the iframe mounted alongside it.
    // Lights the letterbox either side of a vertical video. Purely a gradient,
    // so it costs no request and no filter.
    this.npBackdrop = el('div', 'np-backdrop');
    this.npArt.appendChild(this.npBackdrop);

    this.npArtImg = el('div', 'np-art-img');
    this.npArt.appendChild(this.npArtImg);
    // The YouTube iframe sits on top of the artwork when a YouTube track plays.
    this.npArt.appendChild(this.ytHost);

    // A vertical Short is height-constrained in this stage, so it leaves a
    // column of dead black down each side. These sit in that column: somewhere
    // to press, and somewhere a swipe can start, without taking a pixel from
    // the picture.
    const prevRail = button('np-rail np-rail-prev', '‹', 'Previous short');
    prevRail.addEventListener('click', () => void this.previousShort());
    this.npArt.appendChild(prevRail);

    const nextRail = button('np-rail np-rail-next', '›', 'Next short');
    nextRail.addEventListener('click', () => void this.next('skipped'));
    this.npArt.appendChild(nextRail);

    this.np.appendChild(this.npArt);

    this.npTitle = el('h2', 'np-title', '');
    this.npArtist = el('p', 'np-artist', '');
    this.np.appendChild(this.npTitle);
    this.np.appendChild(this.npArtist);

    this.npWhy = el('p', 'np-why', '');
    this.np.appendChild(this.npWhy);

    const bar = el('div', 'np-bar');
    this.npFill = el('div', 'np-fill');
    bar.appendChild(this.npFill);
    this.attachSeek(bar);
    this.np.appendChild(bar);

    const times = el('div', 'np-times');
    this.npElapsed = el('span', undefined, '0:00');
    this.npTotal = el('span', undefined, '0:00');
    times.appendChild(this.npElapsed);
    times.appendChild(this.npTotal);
    this.np.appendChild(times);

    const controls = el('div', 'np-controls');

    const dislike = button('np-ctl', '✕', 'Not for me');
    dislike.setAttribute('data-label', 'Not for me');
    dislike.addEventListener('click', () => this.react('disliked'));

    this.npPlay = button('np-ctl np-main', '▶', 'Play or pause');
    this.npPlay.addEventListener('click', () => {
      if (!this.player.track) void this.begin();
      else this.player.toggle();
    });

    const next = button('np-ctl np-next', '⏭', 'Next track');
    next.addEventListener('click', () => void this.next('skipped'));

    this.npLike = button('np-ctl', '♡', 'Like');
    this.npLike.setAttribute('data-label', 'Like');
    this.npLike.addEventListener('click', () => this.react('liked'));

    controls.appendChild(dislike);
    controls.appendChild(this.npPlay);
    controls.appendChild(next);
    controls.appendChild(this.npLike);
    this.np.appendChild(controls);

    // Standing instruction, distinct from a dislike: a dislike teaches the
    // model, this removes the track from circulation entirely.
    // In Shorts this belongs on the same row as the reactions, so the whole
    // control strip is one line and the video keeps the height.
    const hideIcon = button('np-ctl np-hide-icon', '⊘', "Don't show this again");
    hideIcon.setAttribute('data-label', 'Never');
    hideIcon.addEventListener('click', () => this.hideCurrent());
    controls.appendChild(hideIcon);

    this.npAdd = button('np-hide', 'Add to playlist');
    this.npAdd.addEventListener('click', () => this.openPlaylistPicker());
    this.np.appendChild(this.npAdd);

    // No second "Don't show this again". The circle-slash in the controls above
    // already calls hideCurrent and carries "Never" as its label, so this was a
    // full-width button doing exactly what the icon beside it does — on a
    // screen with 349 pixels to spend.

    this.npLoading = el('p', 'np-loading', '');
    this.np.appendChild(this.npLoading);

    this.npBuffer = el('img', 'np-buffer') as HTMLImageElement;
    this.npBuffer.hidden = true;
    this.npBuffer.alt = '';
    this.np.appendChild(this.npBuffer);

    this.npTiming = el('p', 'np-timing', '');
    this.np.appendChild(this.npTiming);

    this.npStatus = el('p', 'np-status', '');
    this.np.appendChild(this.npStatus);

    this.attachShortsSwipe();
    this.attachCollapseSwipe();
    this.attachMiniDismiss();
    window.addEventListener('resize', () => this.fitShortsStage());
    this.attachDimTap();
    this.applyBrightness();
    this.np.addEventListener('touchstart', () => this.scheduleAmbient(), { passive: true });
    this.np.addEventListener('click', () => this.scheduleAmbient());

    // Deferred writes have to land before the process does. pagehide is the
    // reliable one on mobile; visibilitychange covers being backgrounded
    // without being closed.
    window.addEventListener('pagehide', () => store.flushWrites());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) store.flushWrites();
    });

    this.root.appendChild(this.np);
  }

  /**
   * Vertical swipe moves through the Shorts feed, the way the format expects.
   * Only bound in shorts mode; elsewhere the overlay scrolls normally.
   */
  private attachShortsSwipe(): void {
    let startY = 0;
    let tracking = false;

    this.np.addEventListener(
      'touchstart',
      (e: TouchEvent) => {
        if (!this.np.classList.contains('shorts')) return;
        tracking = true;
        startY = e.touches[0]?.clientY ?? 0;
      },
      { passive: true },
    );

    this.np.addEventListener(
      'touchend',
      (e: TouchEvent) => {
        if (!tracking || !this.np.classList.contains('shorts')) return;
        tracking = false;
        const endY = e.changedTouches[0]?.clientY ?? startY;
        const travel = startY - endY;
        // Require a deliberate swipe; a tap or a nudge should do nothing.
        if (travel > 60) void this.next('skipped');
        else if (travel < -60) void this.previousShort();
      },
      { passive: true },
    );

    // The desktop equivalent, so the feed is testable in a browser.
    this.np.addEventListener('wheel', (e: WheelEvent) => {
      if (!this.np.classList.contains('shorts')) return;
      if (e.deltaY > 40) {
        e.preventDefault();
        void this.next('skipped');
      } else if (e.deltaY < -40) {
        e.preventDefault();
        void this.previousShort();
      }
    });
  }

  /**
   * Swipe down on the full player to shrink it back to the bar.
   *
   * Only from the top of the overlay, so a swipe that is meant to scroll the
   * screen still scrolls it, and never in Shorts, where a vertical swipe
   * already means something else.
   */
  private attachCollapseSwipe(): void {
    let startY = 0;
    let fromTop = false;

    this.np.addEventListener(
      'touchstart',
      (e: TouchEvent) => {
        fromTop =
          this.np.classList.contains('open') &&
          !this.np.classList.contains('shorts') &&
          this.np.scrollTop <= 2;
        startY = e.touches[0]?.clientY ?? 0;
      },
      { passive: true },
    );

    this.np.addEventListener(
      'touchend',
      (e: TouchEvent) => {
        if (!fromTop) return;
        fromTop = false;
        const travel = (e.changedTouches[0]?.clientY ?? startY) - startY;
        if (travel > 70) this.closeNowPlaying();
      },
      { passive: true },
    );
  }

  /**
   * Throw the bar off either edge to stop playing altogether.
   *
   * Sideways rather than down, because down already means "shrink". It follows
   * the finger so the gesture is visible, and past a third of the width it
   * keeps going and takes the track with it — which matters most on the long
   * mixes, where the alternative is waiting out a load nobody wants any more.
   */
  private attachMiniDismiss(): void {
    let startX = 0;
    let startY = 0;
    let tracking = false;

    this.miniBar.addEventListener(
      'touchstart',
      (e: TouchEvent) => {
        tracking = true;
        startX = e.touches[0]?.clientX ?? 0;
        startY = e.touches[0]?.clientY ?? 0;
        this.miniBar.style.transition = 'none';
      },
      { passive: true },
    );

    this.miniBar.addEventListener(
      'touchmove',
      (e: TouchEvent) => {
        if (!tracking) return;
        const dx = (e.touches[0]?.clientX ?? startX) - startX;
        const dy = (e.touches[0]?.clientY ?? startY) - startY;
        // Sideways only. A finger travelling mostly downward is scrolling.
        if (Math.abs(dy) > Math.abs(dx)) return;
        this.miniBar.style.transform = 'translateX(' + Math.round(dx) + 'px)';
        this.miniBar.style.opacity = String(Math.max(0.25, 1 - Math.abs(dx) / 200));
      },
      { passive: true },
    );

    this.miniBar.addEventListener(
      'touchend',
      (e: TouchEvent) => {
        if (!tracking) return;
        tracking = false;
        const dx = (e.changedTouches[0]?.clientX ?? startX) - startX;
        this.miniBar.style.transition = '';

        if (Math.abs(dx) > MINI_DISMISS_PX) {
          this.miniBar.style.transform = 'translateX(' + (dx > 0 ? 420 : -420) + 'px)';
          this.miniBar.style.opacity = '0';
          window.setTimeout(() => this.dismissPlayback(), 180);
          return;
        }
        // Not far enough: put it back.
        this.miniBar.style.transform = '';
        this.miniBar.style.opacity = '';
      },
      { passive: true },
    );
  }

  /**
   * Stops everything to do with the current track.
   *
   * The load is abandoned as well as the playback — a two-hour mix that is
   * still fetching is exactly what this gesture is for, and leaving the title
   * cards running over a dismissed player would be worse than not having them.
   */
  private dismissPlayback(): void {
    this.stopLoadingCaptions();
    this.startedAt = 0;
    this.handedOffAt = 0;
    this.player.stop();
    this.closeNowPlaying();

    this.miniBar.hidden = true;
    this.miniBar.style.transform = '';
    this.miniBar.style.opacity = '';
    this.root.classList.remove('has-mini');
    this.renderHome();
  }

  /**
   * Goes back to the Short before this one. The current track is pushed to the
   * front of the queue rather than dropped, so swiping back up returns to it
   * instead of skipping past.
   */
  private async previousShort(): Promise<void> {
    const previous = this.shortsBack.pop();
    if (!previous) {
      this.setStatus('That is as far back as it goes');
      return;
    }
    if (this.currentRanked) this.queue.unshift(this.currentRanked);
    await this.playTrack(previous);
  }

  /** Removes a track from circulation for good. */
  private hideCurrent(): void {
    const track = this.player.track;
    if (!track) return;
    this.hidden = store.hideTrack(track.id);
    this.queue = this.queue.filter((r) => r.track.id !== track.id);
    this.setStatus('Hidden — it will not come back');
    void this.next('skipped');
  }

  /**
   * A sheet listing the playlists a track can go into, plus a way to make one
   * on the spot — needing to leave the player, create a playlist and come back
   * would mean the track you wanted is no longer the one playing.
   */
  /**
   * Makes the progress bar draggable.
   *
   * While a drag is in progress the fill follows the finger and playback is
   * left alone, so the bar does not fight the position updates still arriving
   * from the player. The seek happens once, on release.
   */
  private attachSeek(bar: HTMLElement): void {
    const fractionAt = (clientX: number): number => {
      const box = bar.getBoundingClientRect();
      if (box.width <= 0) return 0;
      return Math.max(0, Math.min(1, (clientX - box.left) / box.width));
    };

    const preview = (fraction: number): void => {
      this.seeking = true;
      this.npFill.style.width = fraction * 100 + '%';
      this.npElapsed.textContent = formatTime(fraction * this.player.duration);
    };

    const commit = (fraction: number): void => {
      const duration = this.player.duration;
      this.seeking = false;
      if (duration > 0) this.player.seek(fraction * duration);
    };

    bar.addEventListener('click', (e: MouseEvent) => commit(fractionAt(e.clientX)));

    bar.addEventListener(
      'touchstart',
      (e: TouchEvent) => {
        const touch = e.touches[0];
        if (touch) preview(fractionAt(touch.clientX));
      },
      { passive: true },
    );
    bar.addEventListener(
      'touchmove',
      (e: TouchEvent) => {
        const touch = e.touches[0];
        if (touch) preview(fractionAt(touch.clientX));
      },
      { passive: true },
    );
    bar.addEventListener(
      'touchend',
      (e: TouchEvent) => {
        const touch = e.changedTouches[0];
        commit(touch ? fractionAt(touch.clientX) : 0);
      },
      { passive: true },
    );
  }

  private openPlaylistPicker(): void {
    const track = this.player.track;
    if (!track) return;

    const sheet = el('div', 'sheet');
    const panel = el('div', 'sheet-panel');
    panel.appendChild(el('h3', 'sheet-title', 'Add to playlist'));

    const close = (): void => {
      if (sheet.parentNode) sheet.parentNode.removeChild(sheet);
    };

    const addTo = (id: string): void => {
      const added = store.addToPlaylist(id, track);
      this.setStatus(added ? 'Added to playlist' : 'Already in that playlist');
      this.renderPlaylists();
      close();
    };

    const newOne = button('primary', 'New playlist');
    newOne.addEventListener('click', () => {
      const name = window.prompt('Name this playlist');
      if (name === null) return;
      addTo(store.createPlaylist(name).id);
    });
    panel.appendChild(newOne);

    const list = el('div', 'list');
    for (const playlist of store.loadPlaylists()) {
      const row = button('row');
      const art = el('div', 'row-art', '≡');
      art.style.backgroundColor = tintFor(playlist.name);
      row.appendChild(art);

      const main = el('div', 'row-main');
      main.appendChild(el('span', 'row-title', playlist.name));
      main.appendChild(el('span', 'row-sub', playlist.tracks.length + ' tracks'));
      row.appendChild(main);

      row.addEventListener('click', () => addTo(playlist.id));
      list.appendChild(row);
    }
    panel.appendChild(list);

    const cancel = button('toggle', 'Cancel');
    cancel.addEventListener('click', close);
    panel.appendChild(cancel);

    // Tapping the dimmed area dismisses, but taps inside the panel must not.
    sheet.addEventListener('click', (e) => {
      if (e.target === sheet) close();
    });
    sheet.appendChild(panel);
    this.np.appendChild(sheet);
  }

  /**
   * Holds the screen on while music plays, so the watch sleeping does not stop
   * it, and releases it otherwise.
   *
   * Music only. A Short is something watched, so nothing is gained by keeping
   * the display awake for it beyond draining the battery — and the audio there
   * is not meant to outlive looking at it.
   *
   * This keeps the display on rather than playing with it off. Audio behind a
   * hidden player is not something the embedded player allows, so the wrist
   * still has to be up; it just no longer has to be touched.
   */
  private updateKeepAwake(playing: boolean): void {
    const isMusic = (this.player.track?.kind ?? 'music') !== 'short';
    const want = playing && isMusic && this.prefs.keepScreenOn;
    if (want === this.keepingAwake) return;
    this.keepingAwake = want;

    try {
      window.DotNative?.setKeepAwake(want);
    } catch {
      /* not running in the shell */
    }
  }

  /**
   * After a while with music playing and nothing touched, everything but the
   * player goes dark.
   *
   * The screen has to stay on for the track to keep going, but almost none of
   * it has to stay lit. On an OLED an unlit pixel costs nothing, so dropping
   * the title, controls and glow is most of the saving available without
   * turning the screen off — which the player will not allow.
   */
  private scheduleAmbient(): void {
    window.clearTimeout(this.ambientTimer);
    this.np.classList.remove('ambient');
    this.tunePolling();
    if (!this.prefs.keepScreenOn) return;
    if ((this.player.track?.kind ?? 'music') === 'short') return;

    this.ambientTimer = window.setTimeout(() => {
      if (this.player.playing) {
        this.np.classList.add('ambient');
        this.tunePolling();
      }
    }, AMBIENT_DELAY_MS);
  }

  /** Pushes the current brightness to the shell. Harmless in a browser. */
  private applyBrightness(): void {
    const level = this.dimmed ? DIM_FLOOR : this.prefs.screenBrightness;
    try {
      window.DotNative?.setBrightness(level);
    } catch {
      /* not running in the shell */
    }
  }

  /**
   * Double-tap anywhere that is not a control to drop the screen to its
   * dimmest, and again to come back to the remembered level.
   *
   * Bound to the overlay's own surfaces rather than the video: a tap starting
   * on the player goes to the player, not here, which is also why it is the
   * panels either side that respond.
   */
  private attachDimTap(): void {
    const onTap = (target: EventTarget | null): void => {
      // A double-tap on a rail or a reaction is two presses of that control.
      if (target instanceof HTMLElement && target.closest('button')) return;

      const now = Date.now();
      if (now - this.lastTapAt < DOUBLE_TAP_MS) {
        this.lastTapAt = 0;
        this.dimmed = !this.dimmed;
        this.applyBrightness();
        this.setStatus(this.dimmed ? 'Screen dimmed' : 'Brightness restored');
        return;
      }
      this.lastTapAt = now;
    };

    // A touchscreen fires touchend and then a synthesised click for the same
    // tap. Counting both made one tap look like a double-tap, and a real
    // double-tap toggle twice back to where it started — which is why this
    // appeared to do nothing at all.
    let lastTouchAt = 0;
    this.np.addEventListener(
      'touchend',
      (e: TouchEvent) => {
        lastTouchAt = Date.now();
        onTap(e.target);
      },
      { passive: true },
    );
    this.np.addEventListener('click', (e: MouseEvent) => {
      if (Date.now() - lastTouchAt < 700) return;
      onTap(e.target);
    });
  }

  /**
   * Sets how often the player is polled, from what can actually be seen.
   *
   * Nothing shows progress once the screen has gone ambient, and that is where
   * music spends most of its time — so the player stops being asked at all
   * rather than twice a second for a number nobody reads.
   */
  /** Records how long the two halves of this track start took. */
  private markStarted(): void {
    crashContext('playing');

    // Before the guard, not after it. Reaching here means the player is
    // running, which is the whole reason the cards exist — but the guard below
    // returns whenever no start is being timed, and a second PLAYING event, a
    // resume, or a track already rolling from the preload all arrive that way.
    // The cards carried on over a video that was playing.
    this.stopLoadingCaptions();

    if (this.startedAt <= 0) return;
    const now = Date.now();
    const app = (this.handedOffAt || now) - this.startedAt;
    const player = now - (this.handedOffAt || this.startedAt);
    this.lastTiming = 'app ' + app + 'ms · player ' + (player / 1000).toFixed(1) + 's';
    this.startedAt = 0;
    console.info('start timing:', this.lastTiming);
    this.paintTiming();
  }

  /**
   * Shows title cards over the player while a track loads.
   *
   * One card at a time: the picture goes up where the video will be and its
   * recording plays. When the recording finishes there is a beat, and if the
   * track still has not started the next card takes over. Everything stops the
   * moment there is something to watch.
   */
  private startLoadingCaptions(): void {
    this.stopLoadingCaptions();

    // Shuffled rather than run in order, so a short wait is not always the
    // same two cards.
    this.bufferOrder = BUFFER_CARDS.slice();
    for (let i = this.bufferOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const a = this.bufferOrder[i]!;
      this.bufferOrder[i] = this.bufferOrder[j]!;
      this.bufferOrder[j] = a;
    }
    this.bufferAt = 0;

    this.captionTimer = window.setTimeout(() => this.showBufferCard(), BUFFER_DELAY_MS);
  }

  private showBufferCard(): void {
    // Nothing is being waited for. startedAt is set when a track is asked for
    // and cleared the moment one starts, so it is exactly "a start is pending"
    // — where asking the player whether it is playing is not: tapping a track
    // while another is running leaves the old one playing until the new one
    // replaces it, and this read PLAYING and suppressed the cards for the whole
    // load. They stopped appearing at all.
    if (this.startedAt <= 0) {
      this.stopLoadingCaptions();
      return;
    }

    const name = this.bufferOrder[this.bufferAt % this.bufferOrder.length];
    if (!name) return;
    this.bufferAt++;

    // The picture is fetched now and shown later. Decoding it takes long enough
    // on this hardware to be seen, and a card that appears before its line
    // starts reads as a caption with a delayed voiceover rather than one
    // sentence — the voice has to lead.
    const art = 'buffer/images/' + name + '.png';
    const warm = new Image();
    warm.src = art;

    // A new element per card. Reusing one and swapping src leaves the old
    // decode attached on this WebView, and a stale 'ended' can then fire
    // against the wrong card.
    this.stopBufferVoice();
    const voice = new Audio('buffer/voices/' + name + '.mp3');
    voice.preload = 'auto';
    this.bufferVoice = voice;

    // Shown when the recording is actually running, not when it is asked to.
    let revealed = false;
    const reveal = (): void => {
      if (revealed || this.bufferVoice !== voice) return;
      revealed = true;
      this.npBuffer.src = art;
      this.npBuffer.hidden = false;
    };
    voice.addEventListener('playing', reveal);
    voice.addEventListener('play', reveal);
    // Silent devices and blocked audio still get the card; the picture carries
    // the joke on its own. Long enough that the voice wins whenever it can.
    voice.addEventListener('error', reveal);
    window.setTimeout(reveal, 800);

    const next = (): void => {
      if (this.bufferVoice !== voice) return; // superseded, or already stopped
      this.captionTimer = window.setTimeout(() => this.showBufferCard(), BUFFER_GAP_MS);
    };
    voice.addEventListener('ended', next);
    // A recording that never reports finishing must not strand the card.
    voice.addEventListener('error', next);
    window.setTimeout(next, BUFFER_MAX_CARD_MS);

    void voice
      .play()
      .then(() => {
        console.info('dot: voice ' + name + ' playing');
        // play() resolves after the fact, so a card stopped while it was still
        // starting would begin anyway — a recording talking over a video that
        // had already started.
        if (this.bufferVoice !== voice) {
          try {
            voice.pause();
          } catch {
            /* already gone */
          }
        }
      })
      .catch((err: unknown) => {
        // Blocked or unplayable: the picture still carries the joke. Named,
        // because a silent card is exactly what was reported and there is no
        // other way to find out which of the two it was.
        console.info(
          'dot: voice ' + name + ' failed — ' + (err instanceof Error ? err.name + ': ' + err.message : String(err)),
        );
      });
  }

  private stopBufferVoice(): void {
    const voice = this.bufferVoice;
    this.bufferVoice = null;
    if (!voice) return;
    try {
      voice.pause();
      voice.src = '';
    } catch {
      /* nothing worth doing if it will not stop */
    }
  }

  private stopLoadingCaptions(): void {
    window.clearTimeout(this.captionTimer);
    this.captionTimer = 0;
    this.stopBufferVoice();
    if (this.npBuffer) {
      this.npBuffer.hidden = true;
      this.npBuffer.removeAttribute('src');
    }
    if (this.npLoading) this.npLoading.textContent = '';
  }

  private paintTiming(): void {
    const warm =
      (this.ytEngine.isWarm() ? 'warm' : 'cold') +
      (this.ytEngine.wasServedFromCue() ? ' · preloaded' : '');
    if (this.npTiming) {
      this.npTiming.textContent = this.lastTiming ? this.lastTiming + ' · ' + warm : '';
    }
    if (this.timingLine) {
      this.timingLine.textContent = this.lastTiming
        ? 'Last start: ' + this.lastTiming + ' · player ' + warm + ' at launch'
        : 'Play something, then come back for the start timing.';
    }
  }

  private tunePolling(): void {
    const npOpen = this.np.classList.contains('open');
    const ambient = this.np.classList.contains('ambient');
    this.ytEngine.setPollInterval(ambient ? 0 : npOpen ? 500 : 2000);
  }

  /**
   * Sizes the player to 9:16 from the stage's measured height.
   *
   * The stylesheet's viewport-relative cap is a fallback: it assumes the stage
   * is a fixed fraction of the screen, and the header and controls make that
   * only roughly true — which is why the picture came up short of filling the
   * space. Measuring is exact. Driven from everywhere the layout can settle,
   * because a single call after a class change reads the old height.
   */
  /**
   * Sizes the Shorts stage, and does nothing at all if it is already that size.
   *
   * The guard is the point. This is called from six places, one of which is the
   * player reaching PLAYING — so the stage was being resized in the middle of
   * loading a video. Resizing the host resizes the iframe inside it, the player
   * treats that as its dimensions having changed, and answers by fetching a
   * stream to match: a second video decoding alongside the one already in
   * flight, on a device that gets killed for precisely that.
   *
   * It reproduced as a renderer kill on the first Short of every session and
   * nowhere else, which is exactly when the size actually changes. The crash
   * record named this function; four earlier guesses at the cause — the
   * preload, the stream quality, a stale buffer, the iframe's own attributes —
   * were all wrong.
   *
   * renderTrack already sizes the stage before the load begins, so the correct
   * size is in place by the time any of this matters.
   */
  private fitShortsStage(): void {
    if (!this.np.classList.contains('shorts')) {
      if (this.shortsStageWidth !== 0) {
        this.ytHost.style.width = '';
        this.ytHost.style.marginLeft = '';
        this.ytHost.style.left = '';
        this.ytHost.style.right = '';
        this.shortsStageWidth = 0;
      }
      return;
    }

    const height = this.npArt.clientHeight;
    const stage = this.npArt.clientWidth;
    if (height < 40 || stage < 40) return;

    const width = Math.min(Math.round((height * 9) / 16), stage - 2 * RAIL_WIDTH);
    if (width < 40) return;

    // Already this size: touching the styles anyway is what caused the crash.
    if (width === this.shortsStageWidth) return;
    this.shortsStageWidth = width;

    this.ytHost.style.left = '50%';
    this.ytHost.style.right = 'auto';
    this.ytHost.style.width = width + 'px';
    this.ytHost.style.marginLeft = Math.round(-width / 2) + 'px';

    // The iframe is deliberately left alone. It is created at 100% of this
    // host, so sizing the host is enough, and writing width and height
    // attributes on top of that told the player its dimensions had changed
    // mid-load — which it answers by fetching a stream to match. That is a
    // second video decoding alongside the first, it happened exactly once per
    // session at the first Short opened, and that is exactly when the renderer
    // was being killed.
  }

  private openNowPlaying(): void {
    this.np.classList.add('open');
    this.tunePolling();
    // Once now, and again after the slide-up has settled.
    this.fitShortsStage();
    window.requestAnimationFrame(() => this.fitShortsStage());
    window.setTimeout(() => this.fitShortsStage(), 320);
  }

  private closeNowPlaying(): void {
    this.np.classList.remove('open');
    this.tunePolling();
    if (this.homeStale) this.renderHome();
  }

  /* ------------------------------------------------------------------ rendering */

  private renderTrack(track: Track | null): void {
    if (!track) return;

    this.miniBar.hidden = false;
    // Marks that the mini player is taking a strip off the bottom, so a short
    // screen can give up the greeting to pay for it.
    this.root.classList.add('has-mini');
    this.miniTitle.textContent = track.title;
    this.miniArtist.textContent = track.artist;
    paintArt(this.miniArt, ytThumb(track.artworkUrl, 'default'), track.title, '♪');

    this.npTitle.textContent = track.title;
    this.npArtist.textContent = track.artist;
    this.npTotal.textContent = formatTime(track.duration);
    this.npSource.textContent =
      this.sources.find((s) => s.id === track.sourceId)?.displayName ?? track.sourceId;
    paintArt(this.npArtImg, track.artworkUrl, track.title, '♪');

    // A video source needs a 16:9 stage; artwork-only tracks keep the square.
    const kind = track.kind ?? 'video';
    this.updateKeepAwake(this.player.playing);
    this.np.classList.toggle('video', track.sourceId === 'youtube');
    this.np.classList.toggle('shorts', kind === 'short');
    this.fitShortsStage();
    window.requestAnimationFrame(() => this.fitShortsStage());
    this.npAdd.hidden = kind === 'short';

    this.lastElapsed = '';
    this.lastFillPct = -1;
    this.npLike.textContent = this.likes.has(track.id) ? '♥' : '♡';
    this.npLike.classList.toggle('on', this.likes.has(track.id));

    this.npWhy.textContent = this.explain(track);
    this.setStatus('');
  }

  /**
   * "Why this track" — the current track's tags ranked by what the model has
   * learned about them. This is only possible because the model is linear, and
   * it is the thing no commercial player will show you.
   */
  private explain(track: Track): string {
    const scored = track.tags
      .map((tag) => normalizeTag(tag))
      .filter((tag) => tag.length > 0)
      .map((tag) => ({ tag, weight: this.model.weightAt(hashKey('tag:' + tag)) }))
      .sort((a, b) => b.weight - a.weight);

    const positive = scored.filter((s) => s.weight > 0.01).slice(0, 3);
    if (positive.length > 0) return 'because you like ' + positive.map((p) => p.tag).join(', ');
    if (this.currentRanked?.explored) return 'something new — from Discovery';
    return 'still learning your taste';
  }

  private renderProgress(current: number, duration: number): void {
    if (this.seeking) return;

    // The clock changes once a second and the bar moves in fractions of a
    // percent; writing either on every tick was repainting for nothing.
    const elapsed = formatTime(current);
    if (elapsed !== this.lastElapsed) {
      this.lastElapsed = elapsed;
      this.npElapsed.textContent = elapsed;
    }

    if (duration <= 0) return;
    const pct = Math.round(Math.min(100, (current / duration) * 100) * 2) / 2;
    if (pct === this.lastFillPct) return;
    this.lastFillPct = pct;

    this.npTotal.textContent = formatTime(duration);
    this.npFill.style.width = pct + '%';
    this.miniProgress.style.width = pct + '%';
  }

  private renderPlayState(playing: boolean): void {
    const glyph = playing ? '❚❚' : '▶';
    this.npPlay.textContent = glyph;
    this.miniPlay.textContent = glyph;
  }

  private setStatus(message: string): void {
    this.npStatus.textContent = message;
  }

  /* --------------------------------------------------------------- queue/play */

  private async fromAllSources(fn: (s: MusicSource) => Promise<Track[]>): Promise<Track[]> {
    const settled = await Promise.all(
      // One unreachable source must never empty the feed.
      this.sources.map((s) => fn(s).catch(() => [] as Track[])),
    );
    return settled.flat();
  }

  /**
   * Exploration for right now, rather than the flat setting.
   *
   * A run of skips means the model is confidently wrong, and the worst answer
   * to that is more of what it was already sure about. Each consecutive early
   * skip widens the search; a like or a finished track settles it again.
   */
  private exploreRateNow(): number {
    return Math.min(0.75, this.prefs.discovery + this.skipStreak * 0.06);
  }

  private async refillQueue(): Promise<void> {
    if (this.refilling) return;
    this.refilling = true;
    try {
      // Anything already known locally is free — no request, no quota. With a
      // couple of playlists added this alone fills the queue, which is the
      // whole point: search.list costs 100 units and playlists cost nothing.
      const free = this.youtube.catalogTracks(200);

      // Count only what the feed can actually use. Measuring the floor against
      // the raw catalogue meant a pile of unusable entries read as a healthy
      // pool, so nothing was ever bought and the feed starved.
      const usable = free.filter((t) => (t.kind ?? 'music') !== 'video').length;

      let bought: Track[] = [];
      if (usable < CANDIDATE_FLOOR) {
        const tags = this.prefs.musicTags.length > 0 ? this.prefs.musicTags : ['phonk'];
        const picks = tags.slice().sort(() => Math.random() - 0.5).slice(0, 4);

        const batches = await Promise.all([
          ...picks.map((tag) =>
            this.fromAllSources((s) => s.browse?.('tag', tag, 12) ?? s.search(tag, 12)),
          ),
          this.fromAllSources((s) => s.browse?.('trending', undefined, 10) ?? Promise.resolve([])),
        ]);
        bought = batches.flat();
      }

      // A video about music is not music. Dropped here rather than given a
      // tab, so the Music feed stays recordings and the Shorts feed stays
      // Shorts. Logged, because a false negative silently loses real music.
      const pool = [...free, ...bought];
      const candidates = pool.filter((t) => {
        if ((t.kind ?? 'music') !== 'video') return true;
        console.info('not music:', t.title, '·', t.artist);
        return false;
      });

      const excluded = new Set([...recentlyPlayed(), ...this.hidden]);
      this.lastFill = {
        fetched: pool.length,
        notMusic: pool.length - candidates.length,
        seen: candidates.filter((t) => excluded.has(t.id)).length,
        kept: 0,
      };

      const options = {
        count: QUEUE_TARGET,
        discovery: this.exploreRateNow(),
        // History and hidden both suppress, but only one of them expires.
        exclude: new Set([...recentlyPlayed(), ...this.hidden]),
        bucket: contextBucket(),
        fatigue: this.tagFatigue,
        previousTags: this.player.track?.tags.slice(0, 3) ?? [],
      };
      this.queue = buildQueue(candidates, this.model, options);

      // Rather than show nothing, reach further back. A catalogue this size
      // returns much the same videos for the same tags, so between recent plays
      // and everything permanently put away there were runs of "104 found, 95
      // already seen, 0 kept" — an empty feed, on a working connection, with
      // nine tenths of the day's quota unspent and plenty of playable music
      // sitting in the catalogue.
      //
      // Hearing something from a few hours ago is a far smaller problem than
      // being told there is nothing here. Dislikes and unplayable tracks stay
      // excluded; only the repetition rule gives way.
      if (this.queue.length === 0 && candidates.length > 0) {
        console.info('dot: feed empty after exclusions, allowing older plays back in');
        this.queue = buildQueue(candidates, this.model, {
          ...options,
          exclude: new Set([...store.loadHistory().slice(-12), ...this.hidden]),
        });
      }

      this.mixInFamiliar();

      this.lastFill.kept = this.queue.length;

      if (this.queue.length === 0) {
        this.setStatus(
          this.youtube.configured
            ? 'No tracks available. Check your connection.'
            : 'Add a YouTube key in Settings to start.',
        );
      }
      // Not immediately. This fires at the end of the first refill, which is
      // while the app is still building the feed, decoding its artwork and
      // settling — the busiest moment there is. Starting a video download in
      // the middle of that is what took the whole renderer down with it.
      window.clearTimeout(this.cueTimer);
      this.cueTimer = window.setTimeout(() => this.cueAhead(), CUE_DELAY_MS);
    } finally {
      this.refilling = false;
    }
  }

  /**
   * Hands the player the track most likely to be tapped next, so it can load it
   * during the time the queue is just sitting on screen being read.
   *
   * Only while nothing is playing. Mid-session there is no spare player to
   * preload into — the one we have is busy — so this buys the first tap of a
   * session and nothing else. That is the tap worth buying: it is the one
   * spent staring at a still screen wondering whether the app has hung.
   */
  private cueAhead(): void {
    if (this.player.track) {
      console.info('dot: cueAhead skipped, a track is loaded');
      return;
    }

    // Preloading is an optimisation, and an optimisation that crashes the app
    // is worth less than the seconds it saves. A device that has recently been
    // killed stops being asked to buffer a video nobody has chosen yet; it
    // starts again once it has been stable for a while.
    if (crashedRecently()) {
      console.info('dot: cueAhead standing down, something crashed recently');
      return;
    }
    // The head of what is on screen, not the head of the queue. The queue
    // holds both surfaces mixed together and everything hidden, so its first
    // entry is routinely a Short while the Music feed is showing — which meant
    // the preload was almost never the track that got tapped, and the one
    // measure taken against a seven-second wait quietly never applied.
    const head = this.queueFor(this.surface)[0];
    if (!head || head.track.sourceId !== 'youtube') {
      console.info('dot: cueAhead skipped, ' + this.surface + ' head is ' + (head ? head.track.sourceId : 'empty'));
      return;
    }
    console.info('dot: cueAhead for ' + head.track.id + ' (' + this.surface + ')');
    // Resolved the same way the real play resolves it, so the handle the player
    // is cued with is exactly the one it would otherwise be loaded with.
    void this.youtube
      .resolveStreamUrl(head.track.id)
      .then((handle) => (handle ? this.ytEngine.cue(handle, head.track.kind) : undefined))
      .catch(() => {
        // A failed guess costs nothing; the real play will load it properly.
      });
  }

  /**
   * Folds a couple of liked tracks back into the queue.
   *
   * They are placed a few slots in rather than at the front, so a refill does
   * not always open with something already known, and they carry their real
   * score so the ranking still decides where they sit relative to each other.
   */
  private mixInFamiliar(): void {
    const recent = new Set(store.loadHistory().slice(-FAMILIAR_COOLDOWN));
    const queued = new Set(this.queue.map((r) => r.track.id));
    const bucket = contextBucket();

    const familiar = store
      .loadLikedTracks()
      .filter(
        (t) =>
          (t.kind ?? 'music') !== 'video' &&
          !recent.has(t.id) &&
          !queued.has(t.id) &&
          !this.hidden.has(t.id),
      )
      .slice(0, FAMILIAR_PER_REFILL);

    familiar.forEach((track, i) => {
      const at = Math.min(this.queue.length, 2 + i * 3);
      this.queue.splice(at, 0, {
        track,
        score: this.model.score(featurize(track, bucket, this.playingPrevTags)),
        explored: false,
      });
    });
  }

  private async playTrack(ranked: RankedTrack): Promise<void> {
    // Captured before the swap, so the model is updated with the same context
    // it was scored under rather than with its own tags.
    this.playingPrevTags = this.player.track?.tags.slice(0, 3) ?? [];
    this.currentRanked = ranked;
    const source = this.sources.find((s) => s.id === ranked.track.sourceId);
    if (!source) {
      this.setStatus('No source for this track');
      return;
    }

    this.setStatus('Loading…');
    const url = await source.resolveStreamUrl(ranked.track.id);
    if (!url) {
      this.setStatus('Could not resolve this track');
      return;
    }

    this.startedAt = Date.now();
    this.handedOffAt = 0;
    // The likeliest last thing this app ever does, so it is worth naming.
    // One note, not a trail. A step-by-step trail found the crash — it named
    // fitShortsStage after four wrong guesses — but five storage writes per
    // play cost up to three seconds of the very thing being measured.
    crashContext('loading ' + ranked.track.kind + ' ' + ranked.track.id);
    this.startLoadingCaptions();

    // Start the player first. None of the bookkeeping below affects what is
    // about to be loaded, and doing it first put storage work between the tap
    // and the sound.
    const started = this.player.play(ranked.track, url);

    store.pushHistory(ranked.track.id);
    store.pushRecent(ranked.track);
    for (const tag of ranked.track.tags) {
      const key = tag.toLowerCase().trim();
      if (key) this.tagFatigue.set(key, (this.tagFatigue.get(key) ?? 0) + 1);
    }

    await started;
    this.handedOffAt = Date.now();
    this.renderHome();
  }

  async next(reason: 'skipped' | 'completed'): Promise<void> {
    console.info(
      'dot: next(' + reason + ') queue=' + this.queue.length +
        ' current=' + (this.player.track?.id ?? 'none'),
    );
    if (reason === 'skipped') this.player.skip();

    if (!this.channelLocked && this.queue.length <= QUEUE_LOW_WATER) {
      void this.refillQueue().then(() => this.renderHome());
    }

    // Advance within the surface being watched: a Short should not be followed
    // by a six-minute video just because it was next in the pool.
    // Only Shorts keep a back stack; the music feed has a queue you can see.
    if (this.currentRanked?.track.kind === 'short') {
      this.shortsBack.push(this.currentRanked);
      if (this.shortsBack.length > SHORTS_BACK_LIMIT) this.shortsBack.shift();
    }

    const current: Surface = this.player.track?.kind === 'short' ? 'short' : 'music';
    // Strictly within the surface being listened to. Falling back to anything
    // in the queue meant an empty music queue handed over a Short, and the
    // player switched to Shorts in the middle of listening to music.
    const sameSurface = this.queueFor(current);
    const nextUp = sameSurface[0];
    if (nextUp) this.queue.splice(this.queue.indexOf(nextUp), 1);

    if (current === 'short' && !this.channelLocked) void this.ensureShorts();

    // After the next track is on its way, not before it. With Now Playing open
    // this returns immediately, but from the mini player it rebuilds the whole
    // feed — twenty-five rows and their artwork — and every millisecond of that
    // sat between pressing next and the player being asked for anything.
    window.setTimeout(() => this.renderHome(), 0);

    if (!nextUp) {
      if (this.channelLocked) {
        this.channelLocked = false;
        this.setStatus('End of the channel');
      }
      await this.refillQueue();
      this.renderHome();

      // Within the surface, as above. Taking the head of the whole queue here
      // is the same fault that used to hand over a Short in the middle of
      // listening to music, left behind in the path nobody reaches often.
      const retry = this.queueFor(current)[0];
      if (retry) {
        this.queue.splice(this.queue.indexOf(retry), 1);
        await this.playTrack(retry);
        return;
      }

      // Skipping pauses first and then looks for somewhere to go. With nothing
      // to go to, this returned and left the track paused, silent, with nothing
      // said — which is what pressing next looked like when the feed had run
      // dry: the button appeared to stop the music and do nothing else.
      this.setStatus('Nothing else queued — still playing this one');
      this.player.resume();
      return;
    }
    await this.playTrack(nextUp);
  }

  /** Every finished track lands here. This is where learning happens. */
  private recordEvent(event: PlayEvent): void {
    const track = this.player.track;
    if (!track) return;

    this.model.update(featurize(track, event.contextBucket, this.playingPrevTags), labelFor(event));
    store.saveModelSoon(this.model);
    store.appendEventSoon(event);

    // Some uploads cannot be played outside YouTube at all, which the player
    // reports as an error and then sits on a dead screen. Move past it, and
    // remember it so the same one is never queued again. Deliberately not
    // trained on: a video that refused to load says nothing about taste.
    if (event.outcome === 'error') {
      this.hidden = store.hideTrack(track.id);
      this.queue = this.queue.filter((r) => r.track.id !== track.id);
      void this.next('skipped');
      return;
    }

    // An early skip says the feed is off; anything else says it is not.
    if (event.outcome === 'skipped' && event.playedFraction < 0.5) this.skipStreak++;
    else this.skipStreak = 0;

    // A Short that reaches the end loops, the way the format does. Advancing
    // is something the viewer does by swiping, not something that happens to
    // them. The completion still trains the model first — watching one all the
    // way through is the strongest positive this surface produces.
    if (event.outcome !== 'completed') return;
    if (track.kind === 'short') this.player.replay();
    else void this.next('completed');
  }

  private react(outcome: 'liked' | 'disliked'): void {
    const event = this.player.react(outcome);
    const track = this.player.track;
    if (!event || !track) return;

    this.model.update(featurize(track, event.contextBucket), labelFor(event));
    store.saveModelSoon(this.model);
    store.appendEventSoon(event);

    if (outcome === 'liked') {
      if (this.likes.has(track.id)) {
        this.likes.delete(track.id);
        store.removeLikedTrack(track.id);
      } else {
        this.likes.add(track.id);
        store.addLikedTrack(track);
      }
      store.saveLikes(this.likes);
      this.npLike.textContent = this.likes.has(track.id) ? '♥' : '♡';
      this.npLike.classList.toggle('on', this.likes.has(track.id));
      this.npWhy.textContent = this.explain(track);
    } else {
      this.setStatus('Noted — less like this');
      void this.next('skipped');
    }
  }

  /* ------------------------------------------------------- youtube playlists */

  /**
   * Reads the title and channel out of the embedded player and stores them.
   * Without the Data API this is the only way to learn what a video actually
   * is, so it runs on every YouTube track that starts.
   */
  private async captureYouTubeMetadata(): Promise<void> {
    const track = this.player.track;
    if (!track || track.sourceId !== 'youtube') return;

    // getVideoData can lag the play event slightly.
    for (let attempt = 0; attempt < 6; attempt++) {
      const data = this.ytEngine.videoData();
      if (data && data.title) {
        const updated = this.youtube.ingest(
          data.videoId,
          data.title,
          data.author,
          track.tags,
          track.kind,
        );
        if (!updated) {
          // Only now, with the real title, is this recognisable as filtered
          // content. Move on rather than making the person skip it by hand,
          // and do not train on it — it says nothing about their taste.
          this.setStatus('Skipped — filtered content');
          void this.next('skipped');
          return;
        }
        // Reflect the real name immediately in whatever is on screen.
        track.title = updated.title;
        track.artist = updated.artist;
        this.npTitle.textContent = updated.title;
        this.npArtist.textContent = updated.artist;
        this.miniTitle.textContent = updated.title;
        this.miniArtist.textContent = updated.artist;
        store.pushRecent(track);
        this.renderHome();
        return;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  /** Autoplay policy means the first playback must come from a user gesture. */
  async begin(): Promise<void> {
    this.channelLocked = false;
    if (this.queue.length === 0) await this.refillQueue();
    const first = this.queue.shift();
    this.renderHome();
    if (first) await this.playTrack(first);
  }
}
