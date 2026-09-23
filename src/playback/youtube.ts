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
/**
 * What resolution to ask the player for, by what the track is for.
 *
 * The screen is 320 pixels wide. Music is listened to rather than watched, and
 * on this device usually with the display dimmed, so decoding anything beyond
 * the smallest stream is spent entirely on heat: it costs memory on a device
 * that gets killed for using it, and decode time on a processor already thirty
 * times too slow. Shorts are actually looked at, so they keep the larger one.
 *
 * A request, not an instruction — the player may serve something else.
 */
function qualityFor(kind: string | undefined): string {
  // Shorts are watched rather than listened to, so they keep the larger
  // stream. They were briefly dropped to 'tiny' while hunting a crash that
  // turned out to be a resize, not a decode, and there is no reason to pay for
  // that guess in sharpness.
  return kind === 'short' ? 'small' : 'tiny';
}

const POLL_VISIBLE_MS = 500;
const POLL_MINIMAL_MS = 2000;

/* The IFrame API defines a global; these are the parts we use. */
interface YtPlayer {
  loadVideoById(options: { videoId: string; suggestedQuality?: string }): void;
  cueVideoById(options: { videoId: string; suggestedQuality?: string }): void;
  setPlaybackQuality(quality: string): void;
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

/**
 * Nudges the radio and the TLS session awake just before a load.
 *
 * Between tracks a watch's modem drops to a low-power state and idle
 * connections are dropped, so each track pays for waking the radio and
 * re-handshaking before it can even ask for the video. The static preconnect
 * hints in the page only cover the first load; re-inserting them puts the
 * browser back to work on the same hosts while the player is still starting.
 */
/**
 * Opens connections to the hosts the player is about to use, once.
 *
 * It used to remove each link and add it again on every load and every
 * preload. Removing a preconnect tells the browser it no longer needs that
 * connection and it is free to close the socket; adding it back then starts a
 * fresh DNS lookup, TCP handshake and TLS negotiation — which is the exact work
 * preconnecting exists to avoid, performed immediately before the load that
 * needed it warm. A link that is already there is already doing its job.
 *
 * googlevideo.com is kept for the DNS, though the media itself comes from
 * per-session subdomains that cannot be known in advance.
 */
const WARM_HOSTS = ['https://www.youtube.com', 'https://i.ytimg.com', 'https://googlevideo.com'];

function warmConnections(): void {
  for (const host of WARM_HOSTS) {
    if (document.head.querySelector('link[data-dot-warm="' + host + '"]')) continue;

    const link = document.createElement('link');
    link.rel = 'preconnect';
    link.href = host;
    link.crossOrigin = '';
    link.setAttribute('data-dot-warm', host);
    document.head.appendChild(link);
  }
}

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
  /** The video cue() last handed the player, if it has not been consumed. */
  private cuedHandle: string | null = null;
  /** True between starting a preload and pausing it once it is buffering. */
  private preloading = false;
  /** Whether the track now loaded was already cued when it was asked for. */
  private servedFromCue = false;

  /** For the start-timing readout, so a preloaded start is distinguishable. */
  wasServedFromCue(): boolean {
    return this.servedFromCue;
  }
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

  /**
   * Loads a video into the player without starting it.
   *
   * Cueing does the expensive half of a play — fetching the video's
   * configuration and filling the initial buffer — and the expensive half is
   * all of it here: on this hardware the gap between asking for a video and
   * hearing it is nearly seven seconds, essentially none of which is ours. Doing
   * that while the queue is merely sitting on screen means a tap on the first
   * track has almost nothing left to wait for.
   *
   * It is a hint, not a promise. If the guess was wrong, load() finds the player
   * holding a different video and proceeds exactly as it did before.
   */
  async cue(handle: string, kind?: string): Promise<void> {
    const player = await this.ensurePlayer();
    if (this.track) {
      console.info('dot: cue skipped, already holding ' + this.track.id);
      return; // something is already playing; leave it alone
    }
    warmConnections();

    // Loaded rather than cued. cueVideoById fetches the thumbnail and prepares
    // the player but explicitly does not request the media until playVideo is
    // called — measured here as a settled forty-second cue still costing 6.9s
    // to start, against 7.2s for no cue at all. Preparing the player was never
    // the expensive part.
    //
    // loadVideoById does fetch it. It also starts playing, which is why the
    // volume goes to zero first and the state handler pauses it the instant the
    // media is running.
    this.preloading = true;
    try {
      player.setVolume(0);
    } catch {
      /* older players; the pause below still stops it being heard for long */
    }
    player.loadVideoById({ videoId: handle, suggestedQuality: qualityFor(kind) });
    this.cuedHandle = handle;
    console.info('dot: preloading ' + handle + ' at ' + qualityFor(kind));
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
                // A preload is playback the viewer did not ask for, so none of
                // it is allowed out: no play event, no polling, no sound. The
                // moment the media is actually running it is paused again —
                // and a paused player carries on filling its buffer, which is
                // the whole point. Position is put back to zero so the track
                // still begins where it should.
                if (this.preloading) {
                  if (e.data === YT.PlayerState.PLAYING) {
                    this.preloading = false;
                    try {
                      player.pauseVideo();
                      player.seekTo(0, true);
                      player.setVolume(this.pendingVolume);
                    } catch {
                      /* nothing useful to do; the real play will sort it out */
                    }
                    console.info('dot: preload buffered and paused');
                  }
                  return;
                }

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
                // With nothing playing, the only thing the player can be
                // holding is a cue — a guess at what might be tapped next. A
                // guess that turns out to be unembeddable is not something to
                // interrupt someone with; drop it and let the real play report
                // it, if that track is ever actually asked for.
                if (this.track === null) {
                  this.cuedHandle = null;
                  return;
                }
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

    // Nothing to report until there is something playing, and each tick is two
    // calls across the frame boundary. At 500ms that is roughly thirty round
    // trips during a seven-second load, spent updating a scrubber that has no
    // position yet — on the processor the load is already waiting for. Polling
    // starts again by itself when the player reaches PLAYING.
    this.stopPolling();
    const player = await this.ensurePlayer();
    warmConnections();

    // If this is the track that was cued, the player is already holding it and
    // reloading would throw that work away and pay for it twice. Confirmed
    // against the player rather than trusted: the cue may never have landed.
    const holding = player.getVideoData()?.video_id ?? '(none)';
    const ready = this.cuedHandle === handle && holding === handle;
    console.info(
      'dot: load ' + handle + ' cued=' + (this.cuedHandle ?? '(none)') +
        ' holding=' + holding + ' -> ' + (ready ? 'REUSE' : 'full load'),
    );
    this.cuedHandle = null;
    this.servedFromCue = ready;
    if (ready) {
      // A preload still in flight must stop behaving like one, or the state
      // handler will pause the track the moment it starts.
      this.preloading = false;
      try {
        player.setVolume(this.pendingVolume);
      } catch {
        /* nothing to restore on an older player */
      }
      this.silenceCaptions();
      return;
    }

    // Deliberately no stopVideo here. It was added believing a held stream was
    // behind the Shorts crash; it was not — the crash was a resize, and this
    // survived the revert of everything else from that theory. Tearing the
    // player down and building it up again is work on the path between pressing
    // next and hearing anything, and loadVideoById replaces the video on its
    // own. The check that guarded it was dead in any case: cuedHandle is
    // cleared three lines above it.
    this.preloading = false;

    // The initial buffer the player has to fill before any sound is
    // proportional to the stream it picks, so asking small is asking for a
    // shorter wait as well as less memory.
    const quality = qualityFor(track.kind);
    player.loadVideoById({ videoId: handle, suggestedQuality: quality });
    try {
      player.setPlaybackQuality(quality);
    } catch {
      /* older players ignore this */
    }
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
