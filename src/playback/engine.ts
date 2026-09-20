/**
 * Playback engine abstraction.
 *
 * One implementation today: an <audio> element, for sources that hand back a
 * real stream URL. The abstraction stays because the next one is already known
 * — on the watch, native Media3 replaces the <audio> path, since a WebView
 * cannot keep audio alive with the screen off — and because a source whose
 * audio we cannot touch directly (an embedded player, say) plugs in here too.
 *
 * Player owns the feedback logic; engines only move audio.
 */

import type { Track } from '../types.ts';

export interface EngineEvents {
  onPlay?(): void;
  onPause?(): void;
  onEnded?(): void;
  onTime?(current: number, duration: number): void;
  onError?(message: string): void;
}

export interface PlaybackEngine {
  readonly id: string;
  /** `handle` is whatever the source's resolveStreamUrl returned. */
  load(track: Track, handle: string): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  setVolume(volume: number): void;
  currentTime(): number;
  duration(): number;
  isPaused(): boolean;
  /** Called when another engine takes over, so this one can go quiet. */
  stop(): void;
  setEvents(events: EngineEvents): void;
}
