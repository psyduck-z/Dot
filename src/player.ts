/**
 * Playback orchestration and the feedback it produces.
 *
 * Two jobs, deliberately kept together:
 *
 *  1. Route a track to the right engine — <audio> for direct stream URLs,
 *     Google's IFrame player for YouTube — and present one interface upward so
 *     the UI never has to care which is running.
 *  2. Turn listening into training data. Every track that ends, for any reason,
 *     produces exactly one PlayEvent carrying the fraction actually played.
 */

import { contextBucket } from './reco/features.ts';
import { HtmlAudioEngine } from './playback/htmlAudio.ts';
import { YouTubeEngine } from './playback/youtube.ts';
import type { PlaybackEngine } from './playback/engine.ts';
import type { PlayEvent, PlayOutcome, Track } from './types.ts';

export interface PlayerListener {
  onTrackChange?(track: Track | null): void;
  onProgress?(currentSeconds: number, durationSeconds: number): void;
  onStateChange?(playing: boolean): void;
  /** Fired once per finished track, whatever the reason. */
  onPlayEvent?(event: PlayEvent, track: Track): void;
  onError?(message: string, track: Track): void;
}

export class Player {
  private html = new HtmlAudioEngine();
  private youtube: YouTubeEngine;
  private engine: PlaybackEngine;

  private current: Track | null = null;
  /** Guards against one track reporting twice (e.g. error then ended). */
  private reported = false;
  private listeners: PlayerListener[] = [];
  private volume = 0.8;

  /** The YouTube engine is injected because the app also drives it directly,
   *  for keyless playlist enumeration. */
  constructor(youtube: YouTubeEngine) {
    this.youtube = youtube;
    this.engine = this.html;

    for (const engine of [this.html, this.youtube]) {
      engine.setEvents({
        onPlay: () => this.emit((l) => l.onStateChange?.(true)),
        onPause: () => this.emit((l) => l.onStateChange?.(false)),
        onTime: (cur, dur) => this.emit((l) => l.onProgress?.(cur, dur)),
        onEnded: () => this.finish('completed'),
        onError: (message) => {
          const track = this.current;
          if (!track) return;
          this.emit((l) => l.onError?.(message, track));
          // A dead stream says nothing about taste, so it trains at weight zero.
          this.finish('error');
        },
      });
    }
  }

  addListener(listener: PlayerListener): void {
    this.listeners.push(listener);
  }

  private emit(fn: (l: PlayerListener) => void): void {
    for (const l of this.listeners) {
      try {
        fn(l);
      } catch (err) {
        // A broken listener must not take down playback.
        console.error('player listener failed', err);
      }
    }
  }

  private engineFor(track: Track): PlaybackEngine {
    return track.sourceId === 'youtube' ? this.youtube : this.html;
  }

  private playedFraction(): number {
    const duration = this.engine.duration();
    if (!duration) return 0;
    const f = this.engine.currentTime() / duration;
    return f < 0 ? 0 : f > 1 ? 1 : f;
  }

  /** Closes out the current track, emitting exactly one event. */
  private finish(outcome: PlayOutcome): void {
    const track = this.current;
    if (!track || this.reported) return;
    this.reported = true;

    const event: PlayEvent = {
      ts: Date.now(),
      trackId: track.id,
      outcome,
      // A completed track may report a hair under 1.0.
      playedFraction: outcome === 'completed' ? 1 : this.playedFraction(),
      contextBucket: contextBucket(),
    };
    this.emit((l) => l.onPlayEvent?.(event, track));
  }

  get track(): Track | null {
    return this.current;
  }

  get playing(): boolean {
    return !this.engine.isPaused();
  }

  get position(): number {
    return this.engine.currentTime();
  }

  get duration(): number {
    return this.engine.duration();
  }

  /**
   * Starts a new track. Anything already playing is closed out first, so
   * switching away always produces a skip event with the right fraction.
   */
  async play(track: Track, handle: string): Promise<void> {
    if (this.current && !this.reported) this.finish('skipped');

    const next = this.engineFor(track);
    if (next !== this.engine) {
      // Otherwise a live radio stream keeps buffering behind the new engine.
      this.engine.stop();
      this.engine = next;
    }

    this.current = track;
    this.reported = false;
    this.engine.setVolume(this.volume);
    this.emit((l) => l.onTrackChange?.(track));

    try {
      await this.engine.load(track, handle);
      await this.engine.play();
    } catch (err) {
      // Autoplay policy blocks playback until the user has interacted. That is
      // a UI state, not a taste signal, so it must not train the model.
      this.reported = true;
      const message =
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'Tap play to start audio'
          : err instanceof Error
            ? err.message
            : 'Playback failed';
      this.emit((l) => l.onError?.(message, track));
    }
  }

  toggle(): void {
    if (this.engine.isPaused()) void this.engine.play().catch(() => undefined);
    else this.engine.pause();
  }

  pause(): void {
    this.engine.pause();
  }

  seek(seconds: number): void {
    this.engine.seek(seconds);
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    this.engine.setVolume(this.volume);
  }

  /** Explicit feedback, reported without waiting for the track to end. */
  react(outcome: 'liked' | 'disliked'): PlayEvent | null {
    const track = this.current;
    if (!track) return null;
    return {
      ts: Date.now(),
      trackId: track.id,
      outcome,
      playedFraction: this.playedFraction(),
      contextBucket: contextBucket(),
    };
  }

  /** Ends the current track as a skip. Called when the user presses next. */
  skip(): void {
    this.finish('skipped');
    this.engine.pause();
  }
}
