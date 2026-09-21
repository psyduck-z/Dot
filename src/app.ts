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
import {
  checkForUpdate,
  isRunningDownloaded,
  revertToPackaged,
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
      onProgress: (cur, dur) => this.renderProgress(cur, dur),
      onStateChange: (playing) => {
        this.renderPlayState(playing);
        // Keyless playlists arrive as bare video ids, so the real title only
        // becomes available once the embedded player has loaded the video.
        if (playing) void this.captureYouTubeMetadata();
      },
      onPlayEvent: (event) => this.recordEvent(event),
      onError: (message) => this.setStatus(message + ' — skipping'),
      onTrackChange: (track) => this.renderTrack(track),
    });
  }

  async start(): Promise<void> {
    if (this.prefs.musicTags.length === 0) {
      this.renderOnboarding();
      return;
    }
    this.renderShell();
    // Kick the player off immediately, in parallel with fetching the feed, so
    // the two slow things overlap instead of queueing behind each other.
    this.ytEngine.prewarm();
    this.renderHome();
    this.renderLibrary();
    await this.refillQueue();
    this.renderHome();
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

    this.buildHome(this.panes.get('home')!);
    this.buildSearch(this.panes.get('search')!);
    this.buildLibrary(this.panes.get('library')!);
    this.buildSettings(this.panes.get('settings')!);

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

  private show(name: TabName): void {
    // The channel view lives in Search; leaving it returns to the mixed feed.
    if (name !== 'search') this.releaseChannel();
    this.active = name;
    for (const [key, pane] of this.panes) pane.hidden = key !== name;
    for (const [key, tab] of this.tabs) tab.classList.toggle('on', key === name);
    if (name === 'library') this.renderLibrary();
    // Stats are read from storage, so they would otherwise show whatever was
    // true when the shell was first built.
    if (name === 'settings') this.renderStats();
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
    const seen = new Set([...store.loadHistory(), ...this.hidden]);

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
            this.shortsSearched
              ? 'No Shorts found yet. They turn up as trending and your playlists refresh.'
              : 'Looking for Shorts…',
          ),
        );
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

    this.homeBody.appendChild(el('h2', 'shelf-title', 'Made for you'));
    this.homeBody.appendChild(this.verticalList(items.slice(0, 20), this.emptyTextFor()));

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

  private emptyTextFor(): string {
    if (!this.youtube.configured) return 'Add a YouTube key in Settings to fill this.';
    return this.refilling ? 'Finding music…' : 'Nothing here yet.';
  }

  /**
   * Fetches when a surface has nothing to show.
   *
   * An empty tab used to be a dead end: the feed only refilled when the queue
   * ran low overall, so one surface could sit empty while the other was full.
   */
  private ensureSurface(): void {
    if (this.refilling) return;
    if (this.surface === 'short') {
      void this.ensureShorts();
      return;
    }
    if (this.queueFor('music').length === 0) {
      void this.refillQueue().then(() => this.renderHome());
    }
  }

  private shortCell(ranked: RankedTrack): HTMLElement {
    const cell = button('short-cell');
    const art = el('div', 'short-art');
    paintArt(art, ytThumb(ranked.track.artworkUrl, 'mq'), ranked.track.title, '▶', true);
    cell.appendChild(art);
    cell.appendChild(el('span', 'short-label', ranked.track.title));
    cell.addEventListener('click', () => {
      // Back to the mixed feed.
      this.channelLocked = false;
      const at = this.queue.indexOf(ranked);
      if (at >= 0) this.queue.splice(at, 1);
      void this.playTrack(ranked);
      this.openNowPlaying();
    });
    return cell;
  }

  /* -------------------------------------------------------------------- search */

  private buildSearch(host: HTMLElement): void {
    host.appendChild(el('h1', 'greeting', 'Search'));

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
    host.appendChild(el('h1', 'greeting', 'Your library'));

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
  private buildSettings(host: HTMLElement): void {
    host.appendChild(el('h1', 'greeting', 'Settings'));

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
      'Genres the Music feed is built from.',
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
        if (!problem) void this.refillQueue().then(() => this.renderHome());
      });
    });
    host.appendChild(keyField);
    host.appendChild(keyState);

    host.appendChild(el('h2', 'shelf-title', 'Updates'));
    host.appendChild(
      el(
        'p',
        'muted',
        'Dot can fetch a new build itself, so most changes do not need the APK ' +
          'reinstalled. Leave the box empty to use the official build.',
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
      });
    });
    host.appendChild(checkBtn);

    const reloadBtn = button('toggle', 'Restart to apply');
    reloadBtn.hidden = true;
    reloadBtn.addEventListener('click', () => window.location.reload());
    host.appendChild(reloadBtn);
    host.appendChild(updateState);

    if (isRunningDownloaded()) {
      const revert = button('danger', 'Go back to the built-in version');
      revert.addEventListener('click', () => {
        revertToPackaged();
        window.location.reload();
      });
      host.appendChild(revert);
    }

    host.appendChild(el('h2', 'shelf-title', 'Taste model'));
    this.statsBox = el('div', 'stats');
    host.appendChild(this.statsBox);

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
        void this.refillQueue().then(() => this.renderHome());
      });
      grid.appendChild(chip);
    }
    host.appendChild(grid);
  }

  private renderLibrary(): void {
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

    const hide = button('np-hide', "Don't show this again");
    hide.addEventListener('click', () => this.hideCurrent());
    this.np.appendChild(hide);

    this.npStatus = el('p', 'np-status', '');
    this.np.appendChild(this.npStatus);

    this.attachShortsSwipe();

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

  private openNowPlaying(): void {
    this.np.classList.add('open');
  }

  private closeNowPlaying(): void {
    this.np.classList.remove('open');
  }

  /* ------------------------------------------------------------------ rendering */

  private renderTrack(track: Track | null): void {
    if (!track) return;

    this.miniBar.hidden = false;
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
    this.np.classList.toggle('video', track.sourceId === 'youtube');
    this.np.classList.toggle('shorts', kind === 'short');
    this.npAdd.hidden = kind === 'short';

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
    this.npElapsed.textContent = formatTime(current);
    if (duration > 0) {
      this.npTotal.textContent = formatTime(duration);
      const pct = Math.min(100, (current / duration) * 100);
      this.npFill.style.width = pct + '%';
      this.miniProgress.style.width = pct + '%';
    }
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

      // Only pay for candidates when the local pool is too thin to rank well.
      let bought: Track[] = [];
      if (free.length < CANDIDATE_FLOOR) {
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
      const candidates = [...free, ...bought].filter((t) => {
        if ((t.kind ?? 'music') !== 'video') return true;
        console.info('not music:', t.title, '·', t.artist);
        return false;
      });

      this.queue = buildQueue(candidates, this.model, {
        count: QUEUE_TARGET,
        discovery: this.exploreRateNow(),
        // History and hidden both suppress, but only one of them expires.
        exclude: new Set([...store.loadHistory(), ...this.hidden]),
        bucket: contextBucket(),
        fatigue: this.tagFatigue,
      });

      if (this.queue.length === 0) {
        this.setStatus(
          this.youtube.configured
            ? 'No tracks available. Check your connection.'
            : 'Add a YouTube key in Settings to start.',
        );
      }
    } finally {
      this.refilling = false;
    }
  }

  private async playTrack(ranked: RankedTrack): Promise<void> {
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

    store.pushHistory(ranked.track.id);
    store.pushRecent(ranked.track);
    for (const tag of ranked.track.tags) {
      const key = tag.toLowerCase().trim();
      if (key) this.tagFatigue.set(key, (this.tagFatigue.get(key) ?? 0) + 1);
    }
    await this.player.play(ranked.track, url);
    this.renderHome();
  }

  async next(reason: 'skipped' | 'completed'): Promise<void> {
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
    const sameSurface = this.queueFor(current);
    const nextUp = sameSurface[0] ?? this.queue.find((r) => !this.hidden.has(r.track.id));
    if (nextUp) this.queue.splice(this.queue.indexOf(nextUp), 1);

    if (current === 'short' && !this.channelLocked) void this.ensureShorts();
    this.renderHome();

    if (!nextUp) {
      if (this.channelLocked) {
        this.channelLocked = false;
        this.setStatus('End of the channel');
      }
      await this.refillQueue();
      this.renderHome();
      const retry = this.queue.shift();
      if (retry) await this.playTrack(retry);
      return;
    }
    await this.playTrack(nextUp);
  }

  /** Every finished track lands here. This is where learning happens. */
  private recordEvent(event: PlayEvent): void {
    const track = this.player.track;
    if (!track) return;

    this.model.update(featurize(track, event.contextBucket), labelFor(event));
    store.saveModel(this.model);
    store.appendEvent(event);

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
    store.saveModel(this.model);
    store.appendEvent(event);

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
        const updated = this.youtube.ingest(data.videoId, data.title, data.author, track.tags);
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
