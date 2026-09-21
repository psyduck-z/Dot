/**
 * Persistence.
 *
 * This deliberately uses localStorage rather than IndexedDB, which is the
 * opposite of the obvious choice, so the reasoning matters:
 *
 *  - Everything we store is small. The model is 1024 weights plus 1024
 *    accumulators; as JSON that is roughly 40KB. Prefs, likes, playlists and a
 *    capped event log add little. The whole thing sits comfortably inside the
 *    ~5MB localStorage budget.
 *  - IndexedDB on old Android WebViews has a history of trouble, including a
 *    WebView update that orphaned existing databases outright, and Blob handling
 *    that is unreliable across exactly the Chromium versions we are targeting.
 *  - Less code, synchronous reads, no migration machinery, no open/upgrade races.
 *
 * Audio is never stored here. Offline caching writes files through the native
 * layer and keeps only paths.
 *
 * Every access is wrapped: storage can be disabled or full, and the app must
 * still run, just without remembering anything.
 */

import { TasteModel } from './reco/model.ts';
import {
  DEFAULT_PREFS,
  type Channel,
  type PlayEvent,
  type Playlist,
  type Prefs,
  type Track,
  type TrackId,
} from './types.ts';

const KEY = {
  model: 'dot.model.v1',
  prefs: 'dot.prefs.v1',
  likes: 'dot.likes.v1',
  events: 'dot.events.v1',
  playlists: 'dot.playlists.v1',
  history: 'dot.history.v1',
  recent: 'dot.recent.v1',
  liked: 'dot.likedtracks.v1',
  // v2: v1 entries were classified without the API's category or duration,
  // so nearly all of them say "video" and would keep starving the feed.
  ytCatalog: 'dot.ytcatalog.v2',
  quota: 'dot.quota.v1',
  hidden: 'dot.hidden.v1',
  channels: 'dot.channels.v1',
} as const;

/** Keeps storage bounded; also the window used for repeat suppression. */
const MAX_EVENTS = 200;
/**
 * Doubles as the repeat-suppression window. Shorts are consumed far faster
 * than tracks, so 300 was only a couple of sessions before things came back.
 */
const MAX_HISTORY = 800;
/** Full track objects, so Home can render history without re-fetching. */
const MAX_RECENT = 30;
const MAX_LIKED = 200;
/**
 * The learned-video catalogue is rewritten whole on every play, so its size is
 * a per-track cost, not just a storage one. Uncapped, watching a few hundred
 * Shorts meant serialising a few hundred tracks on every swipe.
 */
const MAX_CATALOG = 150;

/**
 * Only the fields anything actually reads back. A stored Track was carrying
 * play counts, release years and rating flags that nothing consults once the
 * track has been seen — all of it parsed again at every launch.
 */
function slimTrack(t: Track): Track {
  return {
    id: t.id,
    sourceId: t.sourceId,
    title: t.title,
    artist: t.artist,
    artistId: t.artistId,
    duration: t.duration,
    artworkUrl: t.artworkUrl,
    tags: t.tags.slice(0, 8),
    kind: t.kind,
  };
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Quota exceeded, private mode, or storage disabled. The app keeps working
    // from memory; it just will not remember across restarts.
    return false;
  }
}

export function storageAvailable(): boolean {
  try {
    const probe = '__dot_probe';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

export function loadModel(): TasteModel {
  const raw = read<unknown>(KEY.model, null);
  return TasteModel.fromJSON(raw) ?? new TasteModel();
}

export function saveModel(model: TasteModel): void {
  write(KEY.model, model.toJSON());
}

/**
 * Defers the model and event writes.
 *
 * Between them these were the heaviest thing happening per track: the model is
 * two thousand floats serialised to JSON, and the event log rewrites its whole
 * capped history. Neither needs to be on disk the instant it changes — losing
 * the last few seconds of learning to a crash is a far smaller cost than
 * stalling playback on every skip. Coalesced here and flushed on a timer, or
 * immediately when the page is going away.
 */
const WRITE_DELAY_MS = 4000;
let pendingModel: TasteModel | null = null;
let pendingEvents: PlayEvent[] | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let historyDirty = false;
let recentDirty = false;

function scheduleFlush(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    flushWrites();
  }, WRITE_DELAY_MS);
}

export function saveModelSoon(model: TasteModel): void {
  pendingModel = model;
  scheduleFlush();
}

export function appendEventSoon(event: PlayEvent): void {
  if (!pendingEvents) pendingEvents = loadEvents();
  pendingEvents.push(event);
  if (pendingEvents.length > MAX_EVENTS) pendingEvents = pendingEvents.slice(-MAX_EVENTS);
  scheduleFlush();
}

export function flushWrites(): void {
  if (historyDirty && historyCache) {
    write(KEY.history, historyCache);
    historyDirty = false;
  }
  if (recentDirty && recentCache) {
    write(KEY.recent, recentCache);
    recentDirty = false;
  }
  if (pendingModel) {
    write(KEY.model, pendingModel.toJSON());
    pendingModel = null;
  }
  if (pendingEvents) {
    write(KEY.events, pendingEvents);
    pendingEvents = null;
  }
}

/**
 * Preferences and history are read constantly — the filter checks prefs for
 * every track, the API key getter checks them for every request, and a refill
 * reads history several times. Each of those was a fresh JSON.parse of the
 * stored blob. They are small, so keeping them in memory costs nothing and
 * removes a pile of parsing from the hot path.
 */
let prefsCache: Prefs | null = null;
let historyCache: TrackId[] | null = null;
let recentCache: Track[] | null = null;

export function loadPrefs(): Prefs {
  if (prefsCache) return prefsCache;
  const stored = read<Partial<Prefs> & { seedTags?: string[] }>(KEY.prefs, {});
  // Merge rather than replace, so a prefs shape added later gets a default
  // instead of undefined.
  const merged = { ...DEFAULT_PREFS, ...stored };

  // `seedTags` became `musicTags` when Shorts got their own list. Carry the
  // old value over rather than silently wiping someone's picks.
  if (merged.musicTags.length === 0 && Array.isArray(stored.seedTags)) {
    merged.musicTags = stored.seedTags;
  }
  prefsCache = merged;
  return merged;
}

export function savePrefs(prefs: Prefs): void {
  prefsCache = prefs;
  write(KEY.prefs, prefs);
}

export function loadLikes(): Set<TrackId> {
  return new Set(read<TrackId[]>(KEY.likes, []));
}

export function saveLikes(likes: Set<TrackId>): void {
  write(KEY.likes, Array.from(likes));
}

export function loadEvents(): PlayEvent[] {
  return read<PlayEvent[]>(KEY.events, []);
}

export function appendEvent(event: PlayEvent): PlayEvent[] {
  const events = loadEvents();
  events.push(event);
  const trimmed = events.length > MAX_EVENTS ? events.slice(-MAX_EVENTS) : events;
  write(KEY.events, trimmed);
  return trimmed;
}

/**
 * Recently played ids, newest last. Used to stop the endless queue looping —
 * bounded, because over a finite catalogue an endless queue has to eventually
 * allow repeats.
 */
export function loadHistory(): TrackId[] {
  if (!historyCache) historyCache = read<TrackId[]>(KEY.history, []);
  return historyCache;
}

export function pushHistory(id: TrackId): TrackId[] {
  const history = loadHistory().filter((h) => h !== id);
  history.push(id);
  historyCache = history.length > MAX_HISTORY ? history.slice(-MAX_HISTORY) : history;
  historyDirty = true;
  scheduleFlush();
  return historyCache;
}

/**
 * Recently played, newest first, stored as whole tracks rather than ids so the
 * Home screen can render instantly and offline without hitting any API.
 */
export function loadRecent(): Track[] {
  if (!recentCache) recentCache = read<Track[]>(KEY.recent, []);
  return recentCache;
}

/**
 * Both of these are on the path between tapping a track and hearing it, and
 * both rewrite their whole list. Kept in memory so everything that reads them
 * is correct immediately, and written with the other deferred work — a play
 * should not wait on storage to record that it happened.
 */
export function pushRecent(track: Track): Track[] {
  const recent = loadRecent().filter((t) => t.id !== track.id);
  recent.unshift(track);
  recentCache = recent.slice(0, MAX_RECENT);
  recentDirty = true;
  scheduleFlush();
  return recentCache;
}

/** Liked tracks in full, for the Library screen. */
export function loadLikedTracks(): Track[] {
  return read<Track[]>(KEY.liked, []);
}

export function addLikedTrack(track: Track): Track[] {
  const liked = loadLikedTracks().filter((t) => t.id !== track.id);
  liked.unshift(track);
  const trimmed = liked.slice(0, MAX_LIKED);
  write(KEY.liked, trimmed);
  return trimmed;
}

export function removeLikedTrack(id: TrackId): Track[] {
  const liked = loadLikedTracks().filter((t) => t.id !== id);
  write(KEY.liked, liked);
  return liked;
}

/**
 * Channels the user follows. Stored whole so Library can list them with their
 * names and avatars without spending a request to find out who they are.
 */
export function loadChannels(): Channel[] {
  return read<Channel[]>(KEY.channels, []);
}

export function isFollowing(id: string): boolean {
  return loadChannels().some((c) => c.id === id);
}

/** Follows or unfollows, and reports which it did. */
export function toggleChannel(channel: Channel): boolean {
  const all = loadChannels();
  const at = all.findIndex((c) => c.id === channel.id);
  if (at >= 0) {
    all.splice(at, 1);
    write(KEY.channels, all);
    return false;
  }
  all.unshift(channel);
  write(KEY.channels, all);
  return true;
}

/**
 * Tracks the user asked never to see again. Kept separate from play history,
 * which expires — this list does not, because "don't show me this" is a
 * standing instruction rather than a recent event.
 */
export function loadHidden(): Set<TrackId> {
  return new Set(read<TrackId[]>(KEY.hidden, []));
}

export function hideTrack(id: TrackId): Set<TrackId> {
  const hidden = loadHidden();
  hidden.add(id);
  write(KEY.hidden, Array.from(hidden));
  return hidden;
}

export function loadPlaylists(): Playlist[] {
  return read<Playlist[]>(KEY.playlists, []);
}

export function savePlaylists(playlists: Playlist[]): void {
  write(KEY.playlists, playlists);
}

export function createPlaylist(name: string): Playlist {
  const playlist: Playlist = {
    id: 'pl-' + Date.now().toString(36),
    name: name.trim() || 'Untitled',
    tracks: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const all = loadPlaylists();
  all.unshift(playlist);
  savePlaylists(all);
  return playlist;
}

export function deletePlaylist(id: string): Playlist[] {
  const remaining = loadPlaylists().filter((p) => p.id !== id);
  savePlaylists(remaining);
  return remaining;
}

/** Adding a track already present is a no-op rather than a duplicate. */
export function addToPlaylist(id: string, track: Track): boolean {
  const all = loadPlaylists();
  const playlist = all.find((p) => p.id === id);
  if (!playlist) return false;
  if (playlist.tracks.some((t) => t.id === track.id)) return false;

  playlist.tracks.push(track);
  playlist.updatedAt = Date.now();
  savePlaylists(all);
  return true;
}

/** The free YouTube Data API allowance, per project, per day. */
export const YOUTUBE_DAILY_QUOTA = 10000;

/**
 * Google resets quota at midnight Pacific, not local midnight, so the ledger
 * is keyed on the Pacific date. Falling back to the local date is fine: the
 * worst case is the counter resetting a few hours early or late.
 */
function quotaDay(): string {
  try {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function quotaUsed(): number {
  const rec = read<{ day: string; units: number } | null>(KEY.quota, null);
  if (!rec || rec.day !== quotaDay()) return 0;
  return rec.units;
}

/** Records units spent. Called only on a real request, never a cache hit. */
export function quotaSpend(units: number): number {
  const day = quotaDay();
  const rec = read<{ day: string; units: number } | null>(KEY.quota, null);
  const current = rec && rec.day === day ? rec.units : 0;
  const next = current + units;
  write(KEY.quota, { day, units: next });
  return next;
}

/**
 * Video ids Dot has learned about from playlists, with whatever titles the
 * player has reported so far. This is the keyless catalogue: it starts empty
 * and fills in as tracks play, because without the Data API the embedded
 * player is the only thing that knows a video's title.
 */
export function loadYtCatalog(): Record<string, Track> {
  return read<Record<string, Track>>(KEY.ytCatalog, {});
}

export function saveYtCatalog(catalog: Record<string, Track>): void {
  const keys = Object.keys(catalog);
  // Oldest entries go first. Insertion order is what Object.keys gives for
  // string keys, which is the order they were learned in.
  const kept = keys.length <= MAX_CATALOG ? keys : keys.slice(keys.length - MAX_CATALOG);

  const trimmed: Record<string, Track> = {};
  for (const key of kept) {
    const track = catalog[key];
    if (track) trimmed[key] = slimTrack(track);
  }
  write(KEY.ytCatalog, trimmed);
}

/**
 * Small TTL cache, used to keep quota-metered API calls off the wire.
 * A YouTube search costs 100 of the 10,000 daily quota units, so repeating one
 * is genuinely expensive — caching is not a micro-optimisation here.
 */
export function cacheGet<T>(key: string, maxAgeMs: number): T | null {
  const entry = read<{ ts: number; value: T } | null>('dot.cache.' + key, null);
  if (!entry || typeof entry.ts !== 'number') return null;
  if (Date.now() - entry.ts > maxAgeMs) return null;
  return entry.value;
}

export function cacheSet<T>(key: string, value: T): void {
  write('dot.cache.' + key, { ts: Date.now(), value });
}

/** Wipes everything Dot has stored. Used by the reset control in Settings. */
export function clearAll(): void {
  prefsCache = null;
  historyCache = null;
  recentCache = null;
  historyDirty = false;
  recentDirty = false;
  pendingModel = null;
  pendingEvents = null;
  for (const key of Object.values(KEY)) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* nothing useful to do */
    }
  }
  // Cache keys are dynamic, so they need a prefix sweep rather than a fixed list.
  try {
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && key.indexOf('dot.cache.') === 0) doomed.push(key);
    }
    for (const key of doomed) window.localStorage.removeItem(key);
  } catch {
    /* nothing useful to do */
  }
}
