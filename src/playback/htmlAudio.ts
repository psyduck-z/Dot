/**
 * Plain <audio> playback, for any source that hands back a real stream URL.
 *
 * On the watch this is the class that gets replaced by a native Media3 bridge,
 * because a WebView cannot keep audio alive with the screen off.
 */

import type { EngineEvents, PlaybackEngine } from './engine.ts';
import type { Track } from '../types.ts';

export class HtmlAudioEngine implements PlaybackEngine {
  readonly id = 'html-audio';
  private audio: HTMLAudioElement;
  private events: EngineEvents = {};
  private track: Track | null = null;

  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'auto';

    this.audio.addEventListener('timeupdate', () =>
      this.events.onTime?.(this.currentTime(), this.duration()),
    );
    this.audio.addEventListener('play', () => this.events.onPlay?.());
    this.audio.addEventListener('pause', () => this.events.onPause?.());
    this.audio.addEventListener('ended', () => this.events.onEnded?.());
    this.audio.addEventListener('error', () => this.events.onError?.('Could not play this track'));
  }

  setEvents(events: EngineEvents): void {
    this.events = events;
  }

  async load(track: Track, handle: string): Promise<void> {
    this.track = track;
    this.audio.src = handle;
  }

  async play(): Promise<void> {
    await this.audio.play();
  }

  pause(): void {
    this.audio.pause();
  }

  stop(): void {
    this.audio.pause();
    // Dropping the src stops a live radio stream from buffering in the
    // background after we have moved on to another engine.
    this.audio.removeAttribute('src');
    this.audio.load();
  }

  seek(seconds: number): void {
    const duration = this.duration();
    if (!duration) return;
    this.audio.currentTime = Math.max(0, Math.min(duration, seconds));
  }

  setVolume(volume: number): void {
    this.audio.volume = Math.max(0, Math.min(1, volume));
  }

  currentTime(): number {
    return this.audio.currentTime;
  }

  /** Element duration beats catalogue metadata, which is frequently wrong. */
  duration(): number {
    if (Number.isFinite(this.audio.duration) && this.audio.duration > 0) return this.audio.duration;
    return this.track?.duration ?? 0;
  }

  isPaused(): boolean {
    return this.audio.paused;
  }
}
