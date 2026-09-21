/**
 * YouTube source — official APIs only.
 *
 * Search and metadata come from the YouTube Data API v3. Playback is handled by
 * the IFrame Player (see src/playback/youtube.ts), which is Google's own
 * embedded player. Nothing here extracts or proxies a media stream.
 *
 * Quota is the binding constraint and shapes the whole design. The free tier is
 * 10,000 units/day, and costs are wildly uneven:
 *
 *   search.list          100 units   → ~100 searches per day, total
 *   videos.list            1 unit    → up to 50 videos per call
 *   videos.list(chart)     1 unit    → trending, basically free
 *
 * So: searches are cached aggressively, trending is preferred for feed filling,
 * and metadata enrichment batches up to 50 ids into a single 1-unit call.
 */

import * as store from '../store.ts';
import { blockReason } from './filter.ts';
import { classifyKind, parseEmbedAspect } from './kind.ts';
import type { BrowseKind, Channel, MusicSource, Track, TrackId } from '../types.ts';

const API = 'https://www.googleapis.com/youtube/v3';
/** Category 10 is Music. Keeps podcasts and vlogs out of a music feed. */
const MUSIC_CATEGORY = '10';
const TIMEOUT_MS = 12000;
/**
 * Searches are quota-expensive, so cache hard. A week is deliberate: at 100
 * units a search, repeating one is the single easiest way to burn the day's
 * allowance, and music search results barely change day to day.
 */
const SEARCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Costs in quota units, as published by Google. */
const COST_SEARCH = 100;
const COST_LIST = 1;
/** Rotated through so repeated top-ups on one seed fetch different videos. */
const TOPUP_ANGLES = ['', 'new', 'best', 'viral', 'compilation'];
const TRENDING_TTL_MS = 60 * 60 * 1000;

interface YtThumb { url?: string }
interface YtSnippet {
  categoryId?: string;
  title?: string;
  channelTitle?: string;
  channelId?: string;
  publishedAt?: string;
  tags?: string[];
  thumbnails?: { medium?: YtThumb; high?: YtThumb; default?: YtThumb };
}
interface YtVideo {
  id?: string | { videoId?: string };
  snippet?: YtSnippet;
  contentDetails?: { duration?: string };
  statistics?: { viewCount?: string };
  /** `madeForKids` is YouTube's own designation, and the best signal there is. */
  status?: { madeForKids?: boolean };
  /**
   * Embed dimensions follow the source video's orientation — how Shorts are
   * spotted. `embedHeight`/`embedWidth` are only returned when the request
   * passes maxWidth or maxHeight, which is why both are on the query below.
   */
  player?: { embedHtml?: string; embedHeight?: number | string; embedWidth?: number | string };
}

/** ISO-8601 durations, e.g. PT3M45S. */
export function parseIsoDuration(iso: string | undefined): number {
  if (!iso) return 0;
  const m = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return 0;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const mins = Number(m[3] ?? 0);
  const secs = Number(m[4] ?? 0);
  return days * 86400 + hours * 3600 + mins * 60 + secs;
}

/**
 * Every first-run mistake with a Data API key produces a different, and rather
 * unhelpful, error. These are the four that actually happen, with the fix in
 * the message — the alternative is a key that silently returns nothing.
 *
 * Shapes taken from live responses: an invalid key is a 400 carrying
 * `API_KEY_INVALID` in `error.details[].reason`, while the 403s put their reason
 * in `error.errors[].reason`.
 */
export function describeKeyError(status: number, body: unknown): string {
  const error = (body as { error?: { message?: string; errors?: { reason?: string }[]; details?: { reason?: string }[] } } | null)?.error;
  const reasons = [
    ...(error?.errors ?? []).map((e) => e.reason),
    ...(error?.details ?? []).map((d) => d.reason),
  ].filter((r): r is string => typeof r === 'string');
  const has = (needle: string): boolean => reasons.some((r) => r.toLowerCase().indexOf(needle.toLowerCase()) >= 0);

  if (has('API_KEY_INVALID') || has('keyInvalid')) {
    return 'That key is not valid — check for a stray space or a missing character.';
  }
  if (has('accessNotConfigured') || has('SERVICE_DISABLED')) {
    return 'The key is real, but YouTube Data API v3 is not enabled on its project. Enable it in the Google Cloud console, wait a minute, then save again.';
  }
  if (has('ipRefererBlocked') || has('referer') || has('API_KEY_HTTP_REFERRER_BLOCKED')) {
    return 'That key is restricted to certain websites and this page is not one of them. Remove the restriction, or add this address to the allowed referrers.';
  }
  if (has('quotaExceeded') || has('dailyLimitExceeded') || has('RATE_LIMIT_EXCEEDED')) {
    return 'That key is out of quota for today. The free tier is 10,000 units and one search costs 100; it resets at midnight Pacific.';
  }
  if (status === 0) return 'Could not reach the YouTube API — check the connection.';
  return error?.message ?? ('YouTube API error ' + status);
}

/**
 * Prefers the explicit dimensions, which are exact, and falls back to reading
 * them out of the embed markup.
 */
function embedAspect(video: YtVideo): { width: number; height: number } | undefined {
  const w = Number(video.player?.embedWidth);
  const h = Number(video.player?.embedHeight);
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { width: w, height: h };
  return parseEmbedAspect(video.player?.embedHtml);
}

function videoIdOf(id: TrackId): string {
  return id.startsWith('youtube:') ? id.slice('youtube:'.length) : id;
}

/**
 * Channel names are noisy as artist names — "Artist - Topic" is YouTube's
 * auto-generated music channel convention and the suffix is not part of the name.
 */
function cleanArtist(channelTitle: string | undefined): string {
  if (!channelTitle) return 'Unknown';
  return channelTitle.replace(/\s*-\s*Topic$/i, '').trim() || 'Unknown';
}

function toTrack(video: YtVideo): Track | null {
  const rawId = typeof video.id === 'string' ? video.id : video.id?.videoId;
  if (!rawId || !video.snippet) return null;

  const snippet = video.snippet;
  const views = Number(video.statistics?.viewCount ?? '');

  return {
    id: 'youtube:' + rawId,
    sourceId: 'youtube',
    title: snippet.title ?? 'Untitled',
    artist: cleanArtist(snippet.channelTitle),
    artistId: snippet.channelId,
    duration: parseIsoDuration(video.contentDetails?.duration),
    artworkUrl: snippet.thumbnails?.high?.url ?? snippet.thumbnails?.medium?.url,
    // Uploader-supplied tags. Often absent, but when present they are exactly
    // the descriptors the recommender wants.
    tags: Array.isArray(snippet.tags) ? snippet.tags.slice(0, 15) : [],
    madeForKids: video.status?.madeForKids,
    kind: classifyKind({
      title: snippet.title ?? '',
      artist: cleanArtist(snippet.channelTitle),
      tags: Array.isArray(snippet.tags) ? snippet.tags : [],
      duration: parseIsoDuration(video.contentDetails?.duration),
      aspect: embedAspect(video),
      categoryId: snippet.categoryId,
    }),
    playCount: Number.isFinite(views) ? views : undefined,
    releaseYear: snippet.publishedAt ? Number(snippet.publishedAt.slice(0, 4)) : undefined,
  };
}

export class YouTubeSource implements MusicSource {
  readonly id = 'youtube';
  readonly displayName = 'YouTube';
  /**
   * Locally known videos, keyed by track id. Without the Data API this is the
   * entire catalogue: it grows from the playlists you add and fills in real
   * titles as the player reports them.
   */
  private catalog: Record<string, Track> = store.loadYtCatalog();
  /** How many results the last read dropped, for the "N hidden" note. */
  lastHidden = 0;

  /**
   * Read lazily so pasting a key in Settings takes effect without a reload.
   *
   * Deliberately the only source. The bundle is published for over-the-air
   * updates and the repository is public, so a key baked in at build time
   * would be readable by anyone — and a client-side app cannot hide one.
   * It stays on the device that entered it.
   */
  private get apiKey(): string {
    return store.loadPrefs().youtubeApiKey.trim();
  }

  /** True when live search is available. Playback never needs this. */
  get configured(): boolean {
    return this.apiKey.length > 0;
  }

  /** Why the last keyed call failed, if it did. Cleared by the next success. */
  lastKeyProblem: string | null = null;

  /**
   * Checks a key with the cheapest call there is — videos.list costs one unit —
   * and returns null when it works, or a sentence saying what to fix.
   */
  async verifyKey(candidate?: string): Promise<string | null> {
    const key = (candidate ?? this.apiKey).trim();
    if (!key) return 'No key set.';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(
        `${API}/videos?part=id&id=ZSM3w1v-A_Y&key=${encodeURIComponent(key)}`,
        { signal: controller.signal },
      );
      if (res.ok) {
        this.lastKeyProblem = null;
        return null;
      }
      const problem = describeKeyError(res.status, await res.json().catch(() => null));
      this.lastKeyProblem = problem;
      return problem;
    } catch {
      const problem = describeKeyError(0, null);
      this.lastKeyProblem = problem;
      return problem;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Everything Dot knows about locally, newest playlists first. */
  knownTracks(): Track[] {
    return Object.values(this.catalog);
  }

  /**
   * Records the real title and channel the player reported for a video.
   * This is what turns a placeholder into a proper track, and it is the only
   * keyless route to a video's metadata.
   */
  /**
   * Returns null when the track turns out to be filtered content. Some titles
   * are only knowable once the player has loaded the video, so this is the
   * last place a children's upload can be caught — the app skips on null.
   */
  ingest(videoId: string, title: string, author: string, tags: string[] = []): Track | null {
    const level = store.loadPrefs().filterLevel;
    const reason = blockReason({ title, artist: author, tags }, level);
    if (reason) {
      console.info('filtered on play:', reason, '—', title);
      return null;
    }
    const id = 'youtube:' + videoId;
    const existing = this.catalog[id];
    const merged: Track = {
      id,
      sourceId: 'youtube',
      title,
      artist: author.replace(/\s*-\s*Topic$/i, '').trim() || 'YouTube',
      duration: existing?.duration ?? 0,
      artworkUrl: existing?.artworkUrl ?? 'https://i.ytimg.com/vi/' + videoId + '/mqdefault.jpg',
      // A real title finally allows classification. Anything the API already
      // told us is richer than what can be inferred here, so it wins.
      kind:
        existing?.kind ??
        classifyKind({ title, artist: author, tags, duration: existing?.duration ?? 0 }),
      // Keep whatever tags the playlist contributed; they are the taste signal.
      tags: Array.from(new Set([...(existing?.tags ?? []), ...tags])),
    };
    this.catalog[id] = merged;
    store.saveYtCatalog(this.catalog);
    return merged;
  }

  /**
   * Everything already known locally, filtered and ready to rank. Free: no
   * request, no quota. Grows from tracks that have actually been played.
   */
  catalogTracks(limit = 200): Track[] {
    return this.applyFilter(this.knownTracks()).slice(0, limit);
  }

  private localSearch(query: string, limit: number): Track[] {
    const needle = query.toLowerCase();
    return this.applyFilter(this.knownTracks())
      .filter(
        (t) =>
          t.title.toLowerCase().indexOf(needle) >= 0 ||
          t.artist.toLowerCase().indexOf(needle) >= 0 ||
          t.tags.some((tag) => tag.toLowerCase().indexOf(needle) >= 0),
      )
      .slice(0, limit);
  }

  /**
   * `cost` is the endpoint's quota price. It is recorded before the request
   * rather than after, so a failed call still counts — Google charges for
   * those too, and a ledger that undercounts is worse than none.
   */
  private async getJson(path: string, cost: number): Promise<unknown | null> {
    const key = this.apiKey;
    if (!key) return null;
    store.quotaSpend(cost);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${API}${path}&key=${encodeURIComponent(key)}`, {
        signal: controller.signal,
      });
      if (!res.ok) {
        // Quota and key-restriction failures land here mid-session, long after
        // the key was saved, so the reason has to survive for the UI to show.
        this.lastKeyProblem = describeKeyError(res.status, await res.json().catch(() => null));
        console.warn('youtube api', res.status, path.split('?')[0], this.lastKeyProblem);
        return null;
      }
      this.lastKeyProblem = null;
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Turns ids into full tracks. One unit for up to 50 videos, so this is the
   * cheap call and is always worth making rather than trusting search snippets,
   * which carry no duration and no tags.
   */
  /**
   * The single gate every API-sourced track passes through. Duration bounds
   * catch mixes and album rips; the content filter catches children's uploads
   * and non-music, using YouTube's own madeForKids flag where it exists.
   */
  private playable(track: Track): boolean {
    // Anything over ~15 minutes in a music feed is a mix or a full album upload.
    return track.duration > 0 && track.duration < 900;
  }

  /**
   * Content filtering happens here, on the way out, never before caching.
   *
   * Caching filtered results was a real bug: the cache exists to save quota,
   * but it also froze the filter decision, so changing the strictness setting
   * did nothing to anything already fetched. Cache the raw catalogue, decide
   * what to show on every read.
   */
  private applyFilter(tracks: Track[]): Track[] {
    const level = store.loadPrefs().filterLevel;
    if (level === 'off') {
      this.lastHidden = 0;
      return tracks;
    }

    const out: Track[] = [];
    for (const track of tracks) {
      const reason = blockReason(
        {
          title: track.title,
          artist: track.artist,
          tags: track.tags,
          madeForKids: track.madeForKids,
        },
        level,
      );
      if (reason) console.info('filtered:', reason, '—', track.title, '·', track.artist);
      else out.push(track);
    }
    this.lastHidden = tracks.length - out.length;
    return out;
  }

  private async hydrate(ids: string[]): Promise<Track[]> {
    if (ids.length === 0) return [];
    const payload = await this.getJson(
      `/videos?part=snippet,contentDetails,statistics,status,player&maxWidth=480` +
        `&maxResults=50&id=${ids.slice(0, 50).join(',')}`,
      COST_LIST,
    );
    const items = (payload as { items?: YtVideo[] } | null)?.items;
    if (!Array.isArray(items)) return [];

    const out: Track[] = [];
    for (const item of items) {
      const track = toTrack(item);
      if (track && this.playable(track)) out.push(track);
    }
    return out;
  }

  async search(query: string, limit = 20): Promise<Track[]> {
    if (!query.trim()) return [];
    // Without a key, search the playlists you have added rather than the web.
    if (!this.configured) return this.localSearch(query, limit);

    // A search costs the same 100 units whether it returns 5 results or 50,
    // so always buy the full 50 and slice locally. The cache key ignores the
    // caller's limit for the same reason — one purchase serves every caller.
    // v2: entries written before filtering moved to read time hold
    // already-filtered tracks with no madeForKids flag, so they are discarded.
    const cacheKey = 'yt.s2.' + query.toLowerCase();
    const cached = store.cacheGet<Track[]>(cacheKey, SEARCH_TTL_MS);
    if (cached) return this.applyFilter(cached).slice(0, limit);

    const payload = await this.getJson(
      `/search?part=snippet&type=video&maxResults=50&q=${encodeURIComponent(query)}`,
      COST_SEARCH,
    );
    const items = (payload as { items?: YtVideo[] } | null)?.items;
    if (!Array.isArray(items)) return [];

    const ids = items
      .map((i) => (typeof i.id === 'string' ? i.id : i.id?.videoId))
      .filter((id): id is string => typeof id === 'string');

    const tracks = await this.hydrate(ids);
    if (tracks.length > 0) store.cacheSet(cacheKey, tracks);
    return this.applyFilter(tracks).slice(0, limit);
  }

/**
   * Names and avatars for channels already seen in results.
   *
   * One unit for up to fifty, so putting channels above the videos in search
   * costs a single extra request no matter how many turn up.
   */
  async channelsByIds(ids: string[]): Promise<Channel[]> {
    if (!this.configured || ids.length === 0) return [];

    const wanted = ids.slice(0, 50);
    const cacheKey = 'yt.chmeta.' + wanted.join(',');
    const cached = store.cacheGet<Channel[]>(cacheKey, SEARCH_TTL_MS);
    if (cached) return cached;

    const payload = await this.getJson(
      '/channels?part=snippet&maxResults=50&id=' + wanted.join(','),
      COST_LIST,
    );
    const items = (
      payload as {
        items?: Array<{ id?: string; snippet?: { title?: string; thumbnails?: { default?: { url?: string }; medium?: { url?: string } } } }>;
      } | null
    )?.items;
    if (!Array.isArray(items)) return [];

    const out: Channel[] = [];
    for (const item of items) {
      if (!item.id || !item.snippet?.title) continue;
      out.push({
        id: item.id,
        title: item.snippet.title,
        thumbnailUrl: item.snippet.thumbnails?.medium?.url ?? item.snippet.thumbnails?.default?.url,
      });
    }
    if (out.length > 0) store.cacheSet(cacheKey, out);
    return out;
  }

  /** Everything a channel has uploaded, by channel id. Three units. */
  async channelUploadsById(channelId: string, limit = 50): Promise<Track[]> {
    if (!this.configured || !channelId) return [];

    const cacheKey = 'yt.chid.' + channelId;
    const cached = store.cacheGet<Track[]>(cacheKey, SEARCH_TTL_MS);
    if (cached) return this.applyFilter(cached).slice(0, limit);

    const channel = await this.getJson(
      '/channels?part=contentDetails&id=' + encodeURIComponent(channelId),
      COST_LIST,
    );
    const uploads = (
      channel as { items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }> } | null
    )?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) return [];

    const tracks = await this.uploadsPlaylist(uploads);
    if (tracks.length > 0) store.cacheSet(cacheKey, tracks);
    return this.applyFilter(tracks).slice(0, limit);
  }

  /** Pages an uploads playlist and hydrates what it finds. Two units. */
  private async uploadsPlaylist(playlistId: string): Promise<Track[]> {
    const page = await this.getJson(
      '/playlistItems?part=contentDetails&maxResults=50&playlistId=' + encodeURIComponent(playlistId),
      COST_LIST,
    );
    const ids = (
      page as { items?: Array<{ contentDetails?: { videoId?: string } }> } | null
    )?.items
      ?.map((i) => i.contentDetails?.videoId)
      .filter((id): id is string => typeof id === 'string') ?? [];
    return ids.length === 0 ? [] : this.hydrate(ids);
  }

  /**
   * Everything a channel has uploaded, by @handle.
   *
   * Costs three quota units against search.list's hundred: one to turn the
   * handle into the channel's uploads playlist, one to page that playlist, one
   * to hydrate the ids. Worth the extra hop — a channel's own upload list is
   * also complete and in order, which a search over the same channel is not.
   */
  async channelUploads(handle: string, limit = 50): Promise<Track[]> {
    if (!this.configured) return [];
    const name = handle.replace(/^@/, '').trim();
    if (!name) return [];

    const cacheKey = 'yt.ch.' + name.toLowerCase();
    const cached = store.cacheGet<Track[]>(cacheKey, SEARCH_TTL_MS);
    if (cached) return this.applyFilter(cached).slice(0, limit);

    const channel = await this.getJson(
      '/channels?part=contentDetails&forHandle=@' + encodeURIComponent(name),
      COST_LIST,
    );
    const uploads = (
      channel as { items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }> } | null
    )?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) return [];

    const tracks = await this.uploadsPlaylist(uploads);
    if (tracks.length > 0) store.cacheSet(cacheKey, tracks);
    return this.applyFilter(tracks).slice(0, limit);
  }

  async getTrack(id: TrackId): Promise<Track | null> {
    if (!this.configured) return this.catalog[id] ?? null;
    const tracks = await this.hydrate([videoIdOf(id)]);
    return tracks[0] ?? this.catalog[id] ?? null;
  }

  /**
   * There is no stream URL to resolve — playback goes through the IFrame
   * player, which takes a video id. Returning the bare id keeps the MusicSource
   * contract intact; the player routes YouTube tracks to its own engine.
   */
  async resolveStreamUrl(id: TrackId): Promise<string | null> {
    if (!id.startsWith('youtube:')) return null;
    return videoIdOf(id);
  }

  /** One trending chart. `scope` is an extra query fragment, e.g. a category. */
  private async chart(scope: string): Promise<Track[]> {
    const payload = await this.getJson(
      `/videos?part=snippet,contentDetails,statistics,status,player&maxWidth=480` +
        `&chart=mostPopular&maxResults=50${scope}`,
      COST_LIST,
    );
    const items = (payload as { items?: YtVideo[] } | null)?.items;
    if (!Array.isArray(items)) return [];

    const out: Track[] = [];
    for (const item of items) {
      const track = toTrack(item);
      if (track && this.playable(track)) out.push(track);
    }
    return out;
  }

  /**
   * Buys more Shorts when the free pool runs dry. This is the one deliberately
   * paid call in the app — 100 units — so it is only ever triggered by the
   * Shorts tab actually running out, never on a schedule.
   */
  async topUpShorts(seedTags: string[], variant = 0): Promise<Track[]> {
    if (!this.configured) return [];
    const seed = seedTags[Math.floor(Math.random() * Math.max(1, seedTags.length))] ?? 'music';
    // One query per seed returns one fixed set, cached for a week, so asking
    // again brought back exactly what had just been watched. Rotating a
    // modifier gives each seed several distinct pools to draw from.
    const angle = TOPUP_ANGLES[variant % TOPUP_ANGLES.length] ?? '';
    const query = (seed + ' ' + angle).trim() + ' #shorts';

    const cacheKey = 'yt.shorts.' + seed.toLowerCase() + '.' + (variant % TOPUP_ANGLES.length);
    const cached = store.cacheGet<Track[]>(cacheKey, SEARCH_TTL_MS);
    if (cached) return this.applyFilter(cached);

    const payload = await this.getJson(
      // `videoDuration=short` is under four minutes — not Shorts-specific, but
      // it removes most of what could never be one before we pay to hydrate.
      `/search?part=snippet&type=video&videoDuration=short&maxResults=50` +
        `&q=${encodeURIComponent(query)}`,
      COST_SEARCH,
    );
    const items = (payload as { items?: YtVideo[] } | null)?.items;
    if (!Array.isArray(items)) return [];

    const ids = items
      .map((i) => (typeof i.id === 'string' ? i.id : i.id?.videoId))
      .filter((id): id is string => typeof id === 'string');

    // This search already asked for #shorts and a short duration, so anything
    // brief that comes back is treated as one. Demanding classifyKind agree as
    // well discarded nearly the whole result set and left the tab empty.
    const tracks = (await this.hydrate(ids))
      .filter((t) => t.duration > 0 && t.duration <= 180)
      .map((t): Track => ({ ...t, kind: 'short' }));
    if (tracks.length > 0) store.cacheSet(cacheKey, tracks);
    return this.applyFilter(tracks);
  }

  async browse(kind: BrowseKind, key?: string, limit = 20): Promise<Track[]> {
    // Keyless mode: the feed is drawn from the playlists you added.
    if (!this.configured) {
      const known = this.knownTracks();
      if (kind === 'trending' || !key) return known.slice(0, limit);
      const needle = key.toLowerCase();
      return known
        .filter((t) => t.tags.some((tag) => tag.toLowerCase() === needle))
        .slice(0, limit);
    }

    // Trending costs 1 unit against search's 100, so the feed leans on it.
    if (kind === 'trending' || !key) {
      const cached = store.cacheGet<Track[]>('yt.trending2', TRENDING_TTL_MS);
      if (cached) return this.applyFilter(cached).slice(0, limit);

      // Two charts: the music one keeps the Music tab stocked, the general one
      // feeds Videos and turns up most of the Shorts. One unit each.
      const charts = await Promise.all([
        this.chart(`&videoCategoryId=${MUSIC_CATEGORY}`),
        this.chart(''),
      ]);

      const seen = new Set<string>();
      const out: Track[] = [];
      for (const track of charts.flat()) {
        if (seen.has(track.id)) continue;
        seen.add(track.id);
        out.push(track);
      }
      if (out.length > 0) store.cacheSet('yt.trending2', out);
      return this.applyFilter(out).slice(0, limit);
    }

    // The feed refills on several tags at once. Spending 100 units per tag
    // would drain the day in a few refreshes, so prefer what playlists have
    // already taught us and only buy a search when the pool is genuinely thin.
    const needle = key.toLowerCase();
    const known = this.knownTracks().filter((t) =>
      t.tags.some((tag) => tag.toLowerCase() === needle),
    );
    if (known.length >= limit) return known.slice(0, limit);

    const bought = await this.search(key, limit);
    return bought.length > 0 ? bought : known;
  }
}
