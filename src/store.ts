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
  ytCatalog: 'dot.ytcatalog.v1',
  quota: 'dot.quota.v1',
} as const;

/** Keeps storage bounded; also the window used for repeat suppression. */
const MAX_EVENTS = 500;
const MAX_HISTORY = 300;
/** Full track objects, so Home can render history without re-fetching. */
const MAX_RECENT = 30;
const MAX_LIKED = 200;

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

export function loadPrefs(): Prefs {
  const stored = read<Partial<Prefs>>(KEY.prefs, {});
  // Merge rather than replace, so a prefs shape added later gets a default
  // instead of undefined.
  return { ...DEFAULT_PREFS, ...stored };
}

export function savePrefs(prefs: Prefs): void {
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
  return read<TrackId[]>(KEY.history, []);
}

export function pushHistory(id: TrackId): TrackId[] {
  const history = loadHistory().filter((h) => h !== id);
  history.push(id);
  const trimmed = history.length > MAX_HISTORY ? history.slice(-MAX_HISTORY) : history;
  write(KEY.history, trimmed);
  return trimmed;
}

/**
 * Recently played, newest first, stored as whole tracks rather than ids so the
 * Home screen can render instantly and offline without hitting any API.
 */
export function loadRecent(): Track[] {
  return read<Track[]>(KEY.recent, []);
}

export function pushRecent(track: Track): Track[] {
  const recent = loadRecent().filter((t) => t.id !== track.id);
  recent.unshift(track);
  const trimmed = recent.slice(0, MAX_RECENT);
  write(KEY.recent, trimmed);
  return trimmed;
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

export function loadPlaylists(): Playlist[] {
  return read<Playlist[]>(KEY.playlists, []);
}

export function savePlaylists(playlists: Playlist[]): void {
  write(KEY.playlists, playlists);
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
  write(KEY.ytCatalog, catalog);
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
