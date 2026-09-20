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
import { button, clear, el, formatTime, paintArt, tintFor } from './ui/dom.ts';
import type { MusicSource, PlayEvent, Prefs, Track, TrackId } from './types.ts';

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

const QUEUE_TARGET = 20;
const QUEUE_LOW_WATER = 5;

type TabName = 'home' | 'search' | 'library';

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

  // Home shelves
  private shelfMix!: HTMLElement;
  private shelfRecent!: HTMLElement;
  private homeGreeting!: HTMLElement;

  private libraryList!: HTMLElement;
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
    this.player.addListener({
      onProgress: (cur, dur) => this.renderProgress(cur, dur),
      onStateChange: (playing) => {
        this.renderPlayState(playing);
        // Keyless playlists arrive as bare video ids, so the real title only
        // becomes available once the embedded player has loaded the video.
        if (playing) void this.captureYouTubeMetadata();
      },
      onPlayEvent: (event) => this.recordEvent(event),
      onError: (message) => this.setStatus(message),
      onTrackChange: (track) => this.renderTrack(track),
    });
  }

  async start(): Promise<void> {
    if (this.prefs.seedTags.length === 0) {
      this.renderOnboarding();
      return;
    }
    this.renderShell();
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
      this.prefs.seedTags = Array.from(picked);
      store.savePrefs(this.prefs);
      // Cold start: picks become synthetic positive observations, so the first
      // queue is already shaped by them rather than random.
      this.model.seed(this.prefs.seedTags, []);
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
    for (const name of ['home', 'search', 'library'] as TabName[]) {
      const pane = el('section', 'pane');
      pane.hidden = name !== this.active;
      this.panes.set(name, pane);
      paneHost.appendChild(pane);
    }
    this.root.appendChild(paneHost);

    this.buildHome(this.panes.get('home')!);
    this.buildSearch(this.panes.get('search')!);
    this.buildLibrary(this.panes.get('library')!);

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

  private show(name: TabName): void {
    this.active = name;
    for (const [key, pane] of this.panes) pane.hidden = key !== name;
    for (const [key, tab] of this.tabs) tab.classList.toggle('on', key === name);
    if (name === 'library') this.renderLibrary();
  }

  /* ---------------------------------------------------------------------- home */

  private buildHome(host: HTMLElement): void {
    this.homeGreeting = el('h1', 'greeting', 'Good evening');
    host.appendChild(this.homeGreeting);

    this.shelfMix = this.buildShelf(host, 'Made for you');
    this.shelfRecent = this.buildShelf(host, 'Recently played');
  }

  private buildShelf(host: HTMLElement, title: string): HTMLElement {
    host.appendChild(el('h2', 'shelf-title', title));
    const rail = el('div', 'rail');
    host.appendChild(rail);
    return rail;
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

    this.fillRail(
      this.shelfMix,
      this.queue.slice(0, 12),
      'Add a YouTube key in Library to fill this.',
    );

    const recent = store.loadRecent().map((track) => ({ track, score: 0, explored: false }));
    this.fillRail(this.shelfRecent, recent, 'Nothing played yet.');
  }

  private fillRail(rail: HTMLElement, items: RankedTrack[], emptyText: string): void {
    clear(rail);
    if (items.length === 0) {
      rail.appendChild(el('p', 'empty', emptyText));
      return;
    }
    for (const ranked of items) rail.appendChild(this.card(ranked));
  }

  private card(ranked: RankedTrack): HTMLElement {
    const card = button('card');

    const art = el('div', 'card-art');
    paintArt(art, ranked.track.artworkUrl, ranked.track.title, ranked.track.isLive ? '📻' : '♪');
    card.appendChild(art);

    card.appendChild(el('span', 'card-title', ranked.track.title));
    card.appendChild(el('span', 'card-sub', ranked.track.artist));

    if (ranked.explored) {
      const badge = el('span', 'card-badge', 'new');
      card.appendChild(badge);
    }

    card.addEventListener('click', () => {
      const at = this.queue.indexOf(ranked);
      if (at >= 0) this.queue.splice(at, 1);
      void this.playTrack(ranked);
      this.openNowPlaying();
    });
    return card;
  }

  /* -------------------------------------------------------------------- search */

  private buildSearch(host: HTMLElement): void {
    host.appendChild(el('h1', 'greeting', 'Search'));

    const form = el('form', 'searchbar');
    const input = el('input', 'search-input');
    input.type = 'search';
    input.id = 'dot-search';
    input.placeholder = 'Songs, stations, tags';
    input.autocomplete = 'off';
    form.appendChild(input);
    host.appendChild(form);

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

    const found = await this.fromAllSources((s) => s.search(query, 12));
    clear(results);

    if (found.length === 0) {
      // A quota or key failure looks exactly like "no results" otherwise.
      const problem = this.youtube.lastKeyProblem;
      results.appendChild(el('p', 'empty', problem ?? 'Nothing found.'));
      return;
    }

    const bucket = contextBucket();
    const ranked = found
      .map((track) => ({ track, score: this.model.score(featurize(track, bucket)), explored: false }))
      .sort((a, b) => b.score - a.score);

    for (const item of ranked) results.appendChild(this.row(item));
  }

  private row(ranked: RankedTrack): HTMLElement {
    const row = button('row');

    const art = el('div', 'row-art');
    paintArt(art, ranked.track.artworkUrl, ranked.track.title, ranked.track.isLive ? '📻' : '♪');
    row.appendChild(art);

    const main = el('div', 'row-main');
    main.appendChild(el('span', 'row-title', ranked.track.title));

    const subParts = [ranked.track.artist];
    if (ranked.track.isLive) subParts.push('Live');
    main.appendChild(el('span', 'row-sub', subParts.join(' · ')));
    row.appendChild(main);

    row.addEventListener('click', () => {
      void this.playTrack(ranked);
      this.openNowPlaying();
    });
    return row;
  }

  /* ------------------------------------------------------------------- library */

  private buildLibrary(host: HTMLElement): void {
    host.appendChild(el('h1', 'greeting', 'Your library'));

    this.libraryList = el('div', 'list');
    host.appendChild(this.libraryList);

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

    host.appendChild(el('h2', 'shelf-title', 'Your tags'));
    const grid = el('div', 'chip-grid');
    for (const tag of SEED_TAGS) {
      const chip = button('chip', tag);
      chip.style.backgroundColor = tintFor(tag);
      if (this.prefs.seedTags.indexOf(tag) >= 0) chip.classList.add('on');
      chip.addEventListener('click', () => {
        const at = this.prefs.seedTags.indexOf(tag);
        if (at >= 0) {
          this.prefs.seedTags.splice(at, 1);
          chip.classList.remove('on');
        } else {
          this.prefs.seedTags.push(tag);
          chip.classList.add('on');
          // Adding a tag nudges the model rather than resetting what it knows.
          this.model.seed([tag], [], 2, 0.5);
          store.saveModel(this.model);
        }
        store.savePrefs(this.prefs);
      });
      grid.appendChild(chip);
    }
    host.appendChild(grid);

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
    this.npArtImg = el('div', 'np-art-img');
    this.npArt.appendChild(this.npArtImg);
    // The YouTube iframe sits on top of the artwork when a YouTube track plays.
    this.npArt.appendChild(this.ytHost);
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
    this.np.appendChild(bar);

    const times = el('div', 'np-times');
    this.npElapsed = el('span', undefined, '0:00');
    this.npTotal = el('span', undefined, '0:00');
    times.appendChild(this.npElapsed);
    times.appendChild(this.npTotal);
    this.np.appendChild(times);

    const controls = el('div', 'np-controls');

    const dislike = button('np-ctl', '✕', 'Not for me');
    dislike.addEventListener('click', () => this.react('disliked'));

    this.npPlay = button('np-ctl np-main', '▶', 'Play or pause');
    this.npPlay.addEventListener('click', () => {
      if (!this.player.track) void this.begin();
      else this.player.toggle();
    });

    const next = button('np-ctl', '⏭', 'Next track');
    next.addEventListener('click', () => void this.next('skipped'));

    this.npLike = button('np-ctl', '♡', 'Like');
    this.npLike.addEventListener('click', () => this.react('liked'));

    controls.appendChild(dislike);
    controls.appendChild(this.npPlay);
    controls.appendChild(next);
    controls.appendChild(this.npLike);
    this.np.appendChild(controls);

    this.npStatus = el('p', 'np-status', '');
    this.np.appendChild(this.npStatus);

    this.root.appendChild(this.np);
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
    paintArt(this.miniArt, track.artworkUrl, track.title, track.isLive ? '📻' : '♪');

    this.npTitle.textContent = track.title;
    this.npArtist.textContent = track.artist;
    this.npTotal.textContent = track.isLive ? 'live' : formatTime(track.duration);
    this.npSource.textContent =
      this.sources.find((s) => s.id === track.sourceId)?.displayName ?? track.sourceId;
    paintArt(this.npArtImg, track.artworkUrl, track.title, track.isLive ? '📻' : '♪');

    // A video source needs a 16:9 stage; artwork-only tracks keep the square.
    this.np.classList.toggle('video', track.sourceId === 'youtube');

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
    const live = this.player.track?.isLive === true;
    this.npElapsed.textContent = formatTime(current);

    if (live) {
      this.npTotal.textContent = 'live';
      this.npFill.style.width = '100%';
      this.miniProgress.style.width = '100%';
      return;
    }
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

  private async refillQueue(): Promise<void> {
    if (this.refilling) return;
    this.refilling = true;
    try {
      const tags = this.prefs.seedTags.length > 0 ? this.prefs.seedTags : ['phonk'];
      const picks = tags.slice().sort(() => Math.random() - 0.5).slice(0, 4);

      const batches = await Promise.all([
        ...picks.map((tag) =>
          this.fromAllSources((s) => s.browse?.('tag', tag, 12) ?? s.search(tag, 12)),
        ),
        this.fromAllSources((s) => s.browse?.('trending', undefined, 10) ?? Promise.resolve([])),
      ]);

      this.queue = buildQueue(batches.flat(), this.model, {
        count: QUEUE_TARGET,
        discovery: this.prefs.discovery,
        exclude: new Set(store.loadHistory()),
        bucket: contextBucket(),
      });

      if (this.queue.length === 0) this.setStatus('No tracks available. Check your connection.');
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
    await this.player.play(ranked.track, url);
    this.renderHome();
  }

  async next(reason: 'skipped' | 'completed'): Promise<void> {
    if (reason === 'skipped') this.player.skip();

    if (this.queue.length <= QUEUE_LOW_WATER) {
      void this.refillQueue().then(() => this.renderHome());
    }

    const nextUp = this.queue.shift();
    this.renderHome();

    if (!nextUp) {
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

    if (event.outcome === 'completed') void this.next('completed');
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
    if (this.queue.length === 0) await this.refillQueue();
    const first = this.queue.shift();
    this.renderHome();
    if (first) await this.playTrack(first);
  }
}
