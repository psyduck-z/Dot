/**
 * Records why the last session ended, so a crash leaves evidence.
 *
 * The device this runs on has no console, no USB and no developer options, and
 * the copy that actually gets used is the installed one, which the screen
 * mirror deliberately cannot reach. So a crash there is invisible: the page
 * simply comes back, with nothing anywhere saying what happened or when.
 *
 * The mechanism is a mark written at startup and cleared on the way out. A
 * clean exit clears it. A renderer killed for running out of memory does not
 * get to run anything, so the mark survives — and finding one on the next
 * start is proof the last session died rather than ended.
 *
 * What the app was doing is recorded alongside it, because "crashed" and
 * "crashed eight seconds into loading a track" are different problems.
 */

const KEY_MARK = 'dot.crash.mark.v1';
const KEY_LOG = 'dot.crash.log.v1';
/** Enough to see a pattern, few enough to stay small in storage. */
const MAX_RECORDS = 8;

export interface CrashRecord {
  /** When the session that died had started. */
  at: number;
  /** What it was doing when it was last heard from. */
  doing: string;
  /** How it ended: a thrown error, or simply never coming back. */
  how: string;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or unavailable; losing a crash record is not worth throwing */
  }
}

function record(entry: CrashRecord): void {
  const all = read<CrashRecord[]>(KEY_LOG, []);
  all.push(entry);
  while (all.length > MAX_RECORDS) all.shift();
  write(KEY_LOG, all);
}

/** What the app is doing now, so a crash can say what it interrupted. */
export function crashContext(doing: string): void {
  write(KEY_MARK, { at: Date.now(), doing });
}

export function recentCrashes(): CrashRecord[] {
  return read<CrashRecord[]>(KEY_LOG, []);
}

/**
 * Whether something went wrong recently enough to still be a concern.
 *
 * Used to stand down the optional, memory-hungry work. A device that has just
 * been killed for using too much memory is the last one that should be told to
 * start buffering a video nobody has asked for yet.
 */
export function crashedRecently(withinMs = 10 * 60 * 1000): boolean {
  const now = Date.now();
  return recentCrashes().some((c) => now - c.at < withinMs);
}

/**
 * Track ids the app was loading when it died.
 *
 * A video that takes the renderer with it does so reliably — the same Short
 * killed it four times running, because it sits first in the feed and so is
 * the one tapped first. Something about that particular file is more than the
 * decoder on this hardware will survive, and no amount of care elsewhere in the
 * app changes that. It can only be learned and avoided.
 */
export function crashedTrackIds(): string[] {
  const ids: string[] = [];
  for (const crash of recentCrashes()) {
    // "loading short youtube:abc123" — the id is whatever follows the source.
    const match = /(youtube:[A-Za-z0-9_-]{6,})/.exec(crash.doing);
    if (match?.[1]) ids.push(match[1]);
  }
  return ids;
}

export function clearCrashes(): void {
  try {
    window.localStorage.removeItem(KEY_LOG);
  } catch {
    /* nothing to do */
  }
}

/**
 * Called once, before anything that might be the thing that crashes.
 */
export function startCrashWatch(): void {
  const previous = read<{ at?: number; doing?: string } | null>(KEY_MARK, null);
  if (previous && typeof previous.at === 'number') {
    record({
      at: previous.at,
      doing: previous.doing ?? 'unknown',
      how: 'did not shut down cleanly',
    });
  }

  crashContext('starting up');

  // A thrown error is worth recording even when it does not kill the page: the
  // two often turn out to be the same fault caught at different moments.
  window.addEventListener('error', (e) => {
    const ev = e as ErrorEvent;
    const mark = read<{ at?: number; doing?: string } | null>(KEY_MARK, null);
    record({
      at: mark?.at ?? Date.now(),
      doing: mark?.doing ?? 'unknown',
      how: (ev.message ?? 'error') + ' @ ' + (ev.filename ?? '?').split('/').pop() + ':' + (ev.lineno ?? 0),
    });
  });

  // Cleared on the way out, so only a session that never got here looks like a
  // crash. pagehide covers the cases beforeunload misses on mobile WebViews.
  const clean = (): void => {
    try {
      window.localStorage.removeItem(KEY_MARK);
    } catch {
      /* nothing to do */
    }
  };
  window.addEventListener('pagehide', clean);
  window.addEventListener('beforeunload', clean);
}
