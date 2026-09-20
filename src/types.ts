/**
 * Core domain types.
 *
 * These are deliberately source-agnostic: nothing here knows or cares whether a
 * track came from a streaming API, an internet radio station, or a file on the
 * watch. Everything downstream — the recommender, the queue, the library, the UI —
 * is written against these types alone.
 */

/** Globally unique across sources, formatted `${sourceId}:${localId}`. */
export type TrackId = string;

export interface Track {
  id: TrackId;
  /** Which MusicSource produced this, and can resolve it back to a stream. */
  sourceId: string;
  title: string;
  artist: string;
  artistId?: string;
  /** Seconds. 0 means unknown or unbounded (a live radio stream). */
  duration: number;
  artworkUrl?: string;
  /**
   * Free-text descriptors. This is the primary signal for the recommender:
   * on most sources the formal `genre` field is a coarse fixed enum, while the
   * tags carry what the music actually is.
   */
  tags: string[];
  genre?: string;
  mood?: string;
  /** Source-reported popularity, if any. Treated as a weak, bucketed signal only. */
  playCount?: number;
  releaseYear?: number;
  /** True for live streams, which cannot be seeked and never "complete". */
  isLive?: boolean;
  /**
   * The source platform's own "this is children's content" designation, when
   * it reports one. Carried on the track so cached results can still be
   * filtered later, rather than only at the moment they were fetched.
   */
  madeForKids?: boolean;
  /**
   * Which surface this belongs on. Decided locally by the source so the UI
   * never has to re-derive it, and so three tabs cost no extra API calls.
   */
  kind?: 'music' | 'short' | 'video';
}

export interface SourceCapabilities {
  search: boolean;
  /** Can return arbitrary tracks on demand, rather than only a live stream. */
  onDemand: boolean;
  /** Can produce a stable URL suitable for caching to disk. */
  downloadable: boolean;
  /** Supports browsing by tag or genre without a text query. */
  browse: boolean;
}

/**
 * The pluggable audio backend.
 *
 * Implementations must not throw for ordinary failure — return empty arrays and
 * `null` instead — so that one unreachable source never takes down a feed that
 * blends several. Genuine programming errors should still throw.
 */
export interface MusicSource {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: SourceCapabilities;

  search(query: string, limit?: number): Promise<Track[]>;
  getTrack(id: TrackId): Promise<Track | null>;

  /**
   * A URL the audio layer can play. May be short-lived and signed, so callers
   * resolve immediately before playback rather than caching the result.
   */
  resolveStreamUrl(id: TrackId): Promise<string | null>;

  /** Candidate generation for the endless queue. */
  browse?(kind: BrowseKind, key?: string, limit?: number): Promise<Track[]>;
  getSimilar?(id: TrackId, limit?: number): Promise<Track[]>;
}

export type BrowseKind = 'trending' | 'tag' | 'genre' | 'artist';

/** How a play ended. Drives the reward signal. */
export type PlayOutcome =
  | 'completed'
  | 'skipped'
  | 'replayed'
  | 'liked'
  | 'disliked'
  | 'error';

export interface PlayEvent {
  ts: number;
  trackId: TrackId;
  outcome: PlayOutcome;
  /**
   * Fraction of the track actually played, 0..1.
   *
   * Fraction rather than seconds is load-bearing: catalogues are full of both
   * 45-second loops and 6-minute mixes, and "skipped after 30s" means opposite
   * things across those two.
   */
  playedFraction: number;
  /** 0-3, the time-of-day bucket this play happened in. */
  contextBucket: number;
}

export interface Playlist {
  id: string;
  name: string;
  trackIds: TrackId[];
  createdAt: number;
  updatedAt: number;
}

export interface Prefs {
  /**
   * Tags the user opted into, kept per surface. Music and Shorts are genuinely
   * different appetites — the phonk edits worth watching for thirty seconds
   * are not the albums worth playing for an hour — so one shared list made
   * both feeds worse.
   */
  musicTags: string[];
  shortsTags: string[];
  seedArtists: string[];
  /** 0..1. Surfaces the explore/exploit tradeoff directly to the user. */
  discovery: number;
  volume: number;
  enabledSourceIds: string[];
  /** Megabytes. 0 disables offline caching. */
  cacheLimitMb: number;
  /**
   * Google Cloud key for the YouTube Data API. Entirely optional — it only
   * enables live search. Playlist playback needs no key at all.
   */
  youtubeApiKey: string;
  /**
   * How hard to filter children's content and non-music out of the feed.
   * Declared structurally rather than importing the source's type, to keep the
   * domain types free of any dependency on a particular source.
   */
  filterLevel: 'off' | 'normal' | 'strict';
  /** Public YouTube playlists added by the user, with the tags they assigned. */
  youtubePlaylists: SavedPlaylist[];
  /** Captions are off by default; this puts them back under user control. */
  captionsEnabled: boolean;
}

export interface SavedPlaylist {
  /** YouTube playlist id, e.g. PLxxxx or OLAK5uy_xxxx. */
  id: string;
  label: string;
  /**
   * User-assigned tags. A keyless playlist carries no per-track metadata, so
   * these are the recommender's only signal for everything inside it.
   */
  tags: string[];
  /** How many video ids the player reported, for the Library listing. */
  count: number;
}

export const DEFAULT_PREFS: Prefs = {
  musicTags: [],
  shortsTags: [],
  seedArtists: [],
  discovery: 0.2,
  volume: 0.8,
  enabledSourceIds: [],
  cacheLimitMb: 256,
  youtubeApiKey: '',
  filterLevel: 'normal',
  youtubePlaylists: [],
  captionsEnabled: false,
};
