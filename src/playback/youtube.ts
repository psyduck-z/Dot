/**
 * YouTube playback via the official IFrame Player API.
 *
 * This is Google's own embedded player, loaded from youtube.com and driven over
 * its documented JS API. No stream is extracted, proxied or decrypted — the
 * iframe fetches and plays its own media exactly as an embed on any web page
 * does, which is what keeps this within YouTube's terms.
 *
 * Consequences that follow from that, and which the UI has to respect:
 *
 *  - The player must stay visible. YouTube's terms do not permit hiding it to
 *    get audio-only playback, so the app shows it as the artwork.
 *  - Ads play unless the viewer has Premium on that device.
 *  - There is no `timeupdate`; progress has to be polled.
 *  - It needs a reasonably modern WebView, so this path may simply not work on
 *    the watch. That is a known risk, not an oversight.
 */

import type { EngineEvents, PlaybackEngine } from './engine.ts';
import type { Track } from '../types.ts';

const IFRAME_API = 'https://www.youtube.com/iframe_api';
const POLL_MS = 500;
/** Enumeration polls faster than playback progress; a list lands in ~1.5s. */
const LIST_POLL_MS = 250;
const LIST_ATTEMPTS = 80;
const LIST_READY_MS = 15000;
/**
 * A list the player refuses sits at CUED with its id set and an empty array,
 * forever. A real list fills within about a second, so once the player admits
 * to holding the list we asked for, this long without ids means never.
 */
const LIST_EMPTY_GRACE_MS = 5000;

/* The IFrame API defines a global; these are the parts we use. */
interface YtPlayer {
  loadVideoById(id: string): void;
  cueVideoById(id: string): void;
  cuePlaylist(options: { listType: string; list: string }): void;
  getPlaylist(): string[] | null;
  /** Undocumented but present, and the only way to know which list is loaded. */
  getPlaylistId?(): string | null;
  getVideoData(): { video_id?: string; title?: string; author?: string } | null;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  setVolume(volume: number): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  destroy(): void;
}

interface YtNamespace {
  Player: new (host: HTMLElement | string, options: unknown) => YtPlayer;
  PlayerState: { ENDED: number; PLAYING: number; PAUSED: number; BUFFERING: number; CUED: number };
}

declare global {
  interface Window {
    YT?: YtNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<YtNamespace> | null = null;

/** Loads the IFrame API once per page and resolves when the global is ready. */
function loadIframeApi(): Promise<YtNamespace> {
  if (apiPromise) return apiPromise;

  apiPromise = new Promise<YtNamespace>((resolve, reject) => {
    if (window.YT?.Player) {
      resolve(window.YT);
      return;
    }

    // The API invokes this global when it finishes loading. Chain any existing
    // handler rather than clobbering it.
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (window.YT?.Player) resolve(window.YT);
      else reject(new Error('YouTube API loaded without a Player'));
    };

    const script = document.createElement('script');
    script.src = IFRAME_API;
    script.async = true;
    script.onerror = () => reject(new Error('Could not load the YouTube player'));
    document.head.appendChild(script);

    // An old WebView can fail to run the script without firing onerror, so do
    // not let the app hang waiting for a callback that will never come.
    setTimeout(() => reject(new Error('YouTube player timed out')), 15000);
  }).catch((err: unknown) => {
    // Allow a later retry rather than caching the failure forever.
    apiPromise = null;
    throw err;
  });

  return apiPromise;
}

export class YouTubeEngine implements PlaybackEngine {
  readonly id = 'youtube';
  private host: HTMLElement;
  private player: YtPlayer | null = null;
  private events: EngineEvents = {};
  private poll: ReturnType<typeof setInterval> | null = null;
  private ready: Promise<YtPlayer> | null = null;
  private pendingVolume = 80;
  private track: Track | null = null;
  /** Guards against the ENDED state firing repeatedly for one track. */
  private endedFor: string | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  setEvents(events: EngineEvents): void {
    this.events = events;
  }

  private ensurePlayer(): Promise<YtPlayer> {
    if (this.ready) return this.ready;

    this.ready = loadIframeApi().then(
      (YT) =>
        new Promise<YtPlayer>((resolve) => {
          const mount = document.createElement('div');
          this.host.appendChild(mount);

          const player = new YT.Player(mount, {
            width: '100%',
            height: '100%',
            playerVars: {
              // `controls: 0` hides the chrome but the player itself stays
              // visible, which is what the terms require.
              controls: 0,
              playsinline: 1,
              rel: 0,
              modestbranding: 1,
              iv_load_policy: 3,
            },
            events: {
              onReady: () => {
                player.setVolume(this.pendingVolume);
                resolve(player);
              },
              onStateChange: (e: { data: number }) => {
                if (e.data === YT.PlayerState.PLAYING) {
                  this.startPolling();
                  this.events.onPlay?.();
                } else if (e.data === YT.PlayerState.PAUSED) {
                  this.events.onPause?.();
                } else if (e.data === YT.PlayerState.ENDED) {
                  this.stopPolling();
                  const id = this.track?.id ?? null;
                  if (id !== this.endedFor) {
                    this.endedFor = id;
                    this.events.onEnded?.();
                  }
                }
              },
              onError: (e: { data: number }) => {
                // 101 and 150 both mean embedding is disabled for that video,
                // which is common for major-label uploads.
                const message =
                  e.data === 101 || e.data === 150
                    ? 'This track cannot be embedded'
                    : 'YouTube playback error';
                this.events.onError?.(message);
              },
            },
          });
          this.player = player;
        }),
    );

    return this.ready;
  }

  private startPolling(): void {
    if (this.poll) return;
    this.poll = setInterval(() => {
      if (!this.player) return;
      this.events.onTime?.(this.currentTime(), this.duration());
    }, POLL_MS);
  }

  private stopPolling(): void {
    if (!this.poll) return;
    clearInterval(this.poll);
    this.poll = null;
  }

  async load(track: Track, handle: string): Promise<void> {
    this.track = track;
    this.endedFor = null;
    this.host.hidden = false;
    const player = await this.ensurePlayer();
    player.loadVideoById(handle);
  }

  async play(): Promise<void> {
    const player = await this.ensurePlayer();
    player.playVideo();
  }

  pause(): void {
    this.player?.pauseVideo();
  }

  stop(): void {
    this.stopPolling();
    try {
      this.player?.stopVideo();
    } catch {
      /* the iframe may already be gone */
    }
    this.host.hidden = true;
  }

  seek(seconds: number): void {
    this.player?.seekTo(seconds, true);
  }

  setVolume(volume: number): void {
    this.pendingVolume = Math.round(Math.max(0, Math.min(1, volume)) * 100);
    this.player?.setVolume(this.pendingVolume);
  }

  currentTime(): number {
    try {
      return this.player?.getCurrentTime() ?? 0;
    } catch {
      return 0;
    }
  }

  duration(): number {
    try {
      const d = this.player?.getDuration() ?? 0;
      return d > 0 ? d : (this.track?.duration ?? 0);
    } catch {
      return this.track?.duration ?? 0;
    }
  }

  isPaused(): boolean {
    if (!this.player || !window.YT) return true;
    try {
      return this.player.getPlayerState() !== window.YT.PlayerState.PLAYING;
    } catch {
      return true;
    }
  }

  /**
   * Reads the video ids out of a public playlist, with no API key.
   *
   * Cueing a list loads it without starting playback, and getPlaylist() then
   * returns the ids. Two things about that are not obvious and both bite:
   *
   *  - It has to be a throwaway player. On a reused one, getPlaylistId() flips
   *    to the new list within a poll or two while getPlaylist() keeps handing
   *    back the *previous* list's ids — measured still stale after 15s. So a
   *    shared player silently returns the last playlist you added.
   *  - There is no "playlist ready" event, and the array arrives in pieces, so
   *    the first non-empty read is not the whole list. Wait for the player to
   *    confirm the list we asked for and for the ids to stop changing.
   *
   * Cueing deliberately does not autoplay, so this is silent, and using its own
   * player means adding a playlist no longer interrupts what is playing.
   */
  async enumeratePlaylist(listId: string): Promise<string[]> {
    const YT = await loadIframeApi();

    const wrapper = document.createElement('div');
    const mount = document.createElement('div');
    wrapper.appendChild(mount);
    this.host.appendChild(wrapper);
    const wasHidden = this.host.hidden;
    this.host.hidden = false;

    let probe: YtPlayer | null = null;
    try {
      probe = await new Promise<YtPlayer>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('YouTube player timed out')), LIST_READY_MS);
        const created = new YT.Player(mount, {
          width: '100%',
          height: '100%',
          playerVars: { controls: 0, playsinline: 1, rel: 0, modestbranding: 1, iv_load_policy: 3 },
          events: {
            onReady: () => {
              clearTimeout(timer);
              resolve(created);
            },
          },
        });
      });

      probe.cuePlaylist({ listType: 'playlist', list: listId });

      let previous = '';
      let acceptedAt = 0;
      for (let attempt = 0; attempt < LIST_ATTEMPTS; attempt++) {
        await new Promise((r) => setTimeout(r, LIST_POLL_MS));

        let ids: string[] | null = null;
        let loaded: string | null = listId;
        try {
          ids = probe.getPlaylist();
          // Older players may not expose it; then the stability check stands alone.
          loaded = probe.getPlaylistId ? probe.getPlaylistId() : listId;
        } catch {
          continue; /* not ready yet */
        }

        if (loaded === listId && acceptedAt === 0) acceptedAt = Date.now();

        if (!Array.isArray(ids) || ids.length === 0) {
          // Private lists and generated radio mixes land here and never leave.
          if (acceptedAt > 0 && Date.now() - acceptedAt > LIST_EMPTY_GRACE_MS) return [];
          continue;
        }

        const joined = ids.join(',');
        if (loaded === listId && joined === previous) return ids;
        previous = joined;
      }
      return [];
    } catch {
      // A list the player refuses to open — a private one, or a generated radio
      // mix — never fires onReady with a list. Treat it as empty.
      return [];
    } finally {
      try {
        probe?.destroy();
      } catch {
        /* the iframe may already be gone */
      }
      wrapper.remove();
      this.host.hidden = wasHidden;
    }
  }

  /**
   * Title and channel for whatever is loaded. This is how Dot learns real track
   * names without the Data API — the player already knows them.
   */
  videoData(): { videoId: string; title: string; author: string } | null {
    try {
      const data = this.player?.getVideoData();
      if (!data?.video_id || !data.title) return null;
      return {
        videoId: data.video_id,
        title: data.title,
        author: data.author ?? 'Unknown',
      };
    } catch {
      return null;
    }
  }
}
