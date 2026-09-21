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
/**
 * How often progress is read back out of the player.
 *
 * Every tick is two calls across the frame boundary and a handful of DOM
 * writes. The rate is set by what can actually be seen: the scrubber while
 * Now Playing is open, a two-pixel line while it is not, and nothing at all
 * once the screen has gone ambient — which is the state music spends most of
 * its time in.
 */
const POLL_VISIBLE_MS = 500;
const POLL_MINIMAL_MS = 2000;

/* The IFrame API defines a global; these are the parts we use. */
interface YtPlayer {
  loadVideoById(id: string): void;
  unloadModule(name: string): void;
  loadModule(name: string): void;
  setOption(module: string, option: string, value: unknown): void;
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
  private pollMs = POLL_VISIBLE_MS;
  /** Duration is fixed for a video; asking every tick was a wasted call. */
  private knownDuration = 0;
  /** The video captions were last silenced for. */
  private silencedFor: string | null = null;
  private ready: Promise<YtPlayer> | null = null;
  private pendingVolume = 80;
  private track: Track | null = null;
  /** Guards against the ENDED state firing repeatedly for one track. */
  private endedFor: string | null = null;
  /** Off by default; Settings can put captions back. */
  private captionsEnabled = false;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  setEvents(events: EngineEvents): void {
    this.events = events;
  }

  /**
   * Downloads the IFrame API and constructs the player ahead of time.
   *
   * Without this, none of that starts until the first tap on play, so the
   * whole player bundle downloads and initialises *after* the gesture — which
   * is most of the ten to fifteen seconds before a track starts on a slow
   * device. Doing it during startup moves the cost to where a wait is
   * expected, and makes the first play as quick as every later one.
   *
   * The host has to be visible for the iframe to load at all, but it lives
   * inside the Now Playing overlay, which sits translated off-screen until
   * opened. Nothing is shown.
   */
  /** Whether the player finished building before it was first needed. */
  isWarm(): boolean {
    return this.player !== null;
  }

  prewarm(): void {
    this.host.hidden = false;
    void this.ensurePlayer().catch(() => {
      // A cold start failing is not fatal; the first real play retries.
      this.host.hidden = true;
    });
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
              // Telling the player its embedding origin up front avoids a
              // round of postMessage handshaking it otherwise does to work it
              // out, which is slow on the watch's appassets:// style origin.
              origin: window.location.origin,
              // Do not force captions on. This alone is not enough — it only
              // means "do not turn them on by default", and a viewer whose
              // YouTube account has captions enabled still gets them, hence
              // silenceCaptions() below.
              cc_load_policy: 0,
            },
            events: {
              onReady: () => {
                player.setVolume(this.pendingVolume);
                this.silenceCaptions();
                resolve(player);
              },
              onStateChange: (e: { data: number }) => {
                if (e.data === YT.PlayerState.PLAYING) {
                  this.silenceCaptions();
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

  /**
   * `ms` of zero stops it. Called as the UI's visibility changes, so a player
   * nobody is watching is not being interrogated twice a second.
   */
  setPollInterval(ms: number): void {
    if (ms === this.pollMs && (ms === 0) === (this.poll === null)) return;
    this.pollMs = ms;
    this.stopPolling();
    if (ms > 0 && !this.isPaused()) this.startPolling();
  }

  private startPolling(): void {
    if (this.poll || this.pollMs <= 0) return;
    this.poll = setInterval(() => {
      if (!this.player) return;
      this.events.onTime?.(this.currentTime(), this.duration());
    }, this.pollMs);
  }

  private stopPolling(): void {
    if (!this.poll) return;
    clearInterval(this.poll);
    this.poll = null;
  }

  /**
   * Turns captions off.
   *
   * `cc_load_policy: 0` only means "do not switch them on by default" — it does
   * not override a viewer whose YouTube account prefers captions. Unloading the
   * caption modules does. Both module names are tried because the player has
   * used each at different times, and neither is guaranteed to be loaded yet,
   * so every call is individually guarded.
   */
  setCaptionsEnabled(enabled: boolean): void {
    this.captionsEnabled = enabled;
    this.silencedFor = null;
    if (!enabled) {
      this.silenceCaptions();
      return;
    }
    // Unloading the module is not reversible by flag alone — without loading
    // it back, switching subtitles on did nothing until the page reloaded.
    const player = this.player;
    if (!player) return;
    for (const moduleName of ['captions', 'cc']) {
      try {
        player.loadModule(moduleName);
      } catch {
        /* this video has no caption track */
      }
    }
  }

  private silenceCaptions(): void {
    const player = this.player;
    if (!player || this.captionsEnabled) return;
    // PLAYING fires on every resume and after every seek; the caption track
    // only changes when the video does.
    const current = this.track?.id ?? null;
    if (current !== null && current === this.silencedFor) return;
    this.silencedFor = current;
    for (const moduleName of ['captions', 'cc']) {
      try {
        player.unloadModule(moduleName);
      } catch {
        /* module not loaded for this video */
      }
    }
    try {
      player.setOption('captions', 'track', {});
    } catch {
      /* no caption track on this video */
    }
  }

  async load(track: Track, handle: string): Promise<void> {
    this.track = track;
    this.endedFor = null;
    this.knownDuration = 0;
    this.host.hidden = false;
    const player = await this.ensurePlayer();
    player.loadVideoById(handle);
    // Each video brings its own caption track, so this has to run per load.
    this.silenceCaptions();
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
    if (this.knownDuration > 0) return this.knownDuration;
    try {
      const d = this.player?.getDuration() ?? 0;
      if (d > 0) this.knownDuration = d;
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
