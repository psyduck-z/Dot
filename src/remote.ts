/**
 * Screen mirroring for development.
 *
 * The watch has no USB, no developer options and no root, so scrcpy and every
 * other way of seeing what the device is doing are unavailable. What is
 * available: Dot is a web app, and the watch can reach the machine serving it.
 * So the app describes its own screen, posts that to the relay, and carries out
 * whatever came back.
 *
 * Only ever runs when Dot was served over plain HTTP, which on this device
 * means the dev server and nothing else — the installed app is served from
 * https://appassets.androidplatform.net, so a shipped build cannot reach here
 * even if this code is in the bundle. There is no setting to get it wrong.
 *
 * The device this exists for is slow, so the tick is deliberately cheap: the
 * DOM is serialized once and left out of the request when it has not changed,
 * and the reply to the POST carries the commands rather than costing a second
 * request. The request itself always goes, because it is the only thing that
 * brings commands back.
 */

const TICK_MS = 800;
const RELAY_PORT = 5175;
/**
 * Floor between self-reloads.
 *
 * A save that triggers several rebuilds in quick succession would otherwise
 * reload the device repeatedly, and a reload on this hardware is not cheap.
 */
const RELOAD_GUARD_MS = 5000;

/**
 * Last known state of the link, for Settings to show.
 *
 * Mirroring that fails quietly is worse than no mirroring: a watch that cannot
 * reach the relay looks exactly like one that was never pointed at it.
 */
export interface MirrorStatus {
  active: boolean;
  relay: string;
  lastOkAt: number;
  lastError: string;
  sent: number;
}

const status: MirrorStatus = { active: false, relay: '', lastOkAt: 0, lastError: '', sent: 0 };

/**
 * The last few things that went wrong, carried in the snapshot.
 *
 * Debugging this device otherwise means inferring a crash from a tick counter,
 * which is guesswork dressed up as evidence. A watch with no console, no USB
 * and no developer options has no other way to say what threw.
 *
 * Bounded, and installed once: a page that is failing repeatedly must not turn
 * its own error reporting into the reason it runs out of memory.
 */
const LOG_MAX = 12;
const log: string[] = [];
let logInstalled = false;

function note(kind: string, text: string): void {
  const line = kind + ': ' + text.slice(0, 200);
  if (log[log.length - 1] === line) return; // a loop should not fill the buffer
  log.push(line);
  while (log.length > LOG_MAX) log.shift();
}

function installLogging(): void {
  if (logInstalled) return;
  logInstalled = true;

  window.addEventListener('error', (e) => {
    const ev = e as ErrorEvent;
    note('error', (ev.message ?? 'error') + ' @ ' + (ev.filename ?? '?') + ':' + (ev.lineno ?? 0));
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = (e as PromiseRejectionEvent).reason;
    note('reject', reason instanceof Error ? reason.message : String(reason));
  });

  // Wrapped rather than replaced, so anything already watching the console
  // still sees what it saw.
  const original = console.error;
  console.error = function (...args: unknown[]): void {
    note('console', args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
    original.apply(console, args as never[]);
  };

  // Deliberate diagnostics, marked so they can be picked out of the ordinary
  // chatter. Anything logged as "dot: ..." is something a decision point was
  // asked to explain about itself.
  const info = console.info;
  console.info = function (...args: unknown[]): void {
    const text = args.map((a) => String(a)).join(' ');
    if (text.indexOf('dot:') === 0) note('dot', text.slice(4).trim());
    info.apply(console, args as never[]);
  };
}

/**
 * The bundle this page was loaded with, as the relay reported it on the first
 * tick, and the guard against reloading in a loop.
 *
 * Compared against itself rather than against a clock: the watch and the
 * machine serving it have no reason to agree on the time, and a comparison
 * against Date.now() here would either reload constantly or never.
 */
let knownBundle = 0;

/**
 * When this page last reloaded itself, kept where a reload cannot reach it.
 *
 * It lived in a module variable first, which cannot work: reloading is exactly
 * the thing that resets module state, so every reload cleared the evidence that
 * it had happened and three rebuilds in a row produced three reloads. Session
 * storage survives the reload and is discarded when the app closes, which is
 * the lifetime this actually wants.
 */
const RELOAD_KEY = 'dot.mirror.reloadedAt';

function lastReloadAt(): number {
  try {
    return Number(window.sessionStorage.getItem(RELOAD_KEY) ?? '0') || 0;
  } catch {
    return 0;
  }
}

function markReloaded(): void {
  try {
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    /* no session storage: the guard lapses, which only costs extra reloads */
  }
}

export function mirrorStatus(): MirrorStatus {
  return status;
}

/**
 * Where everything is scrolled to, written onto the copy being sent.
 *
 * Scroll position is not in the markup, so a snapshot of the DOM alone always
 * redraws at the top however far down the device actually is — which makes a
 * scrolled screen unreadable from the other end, and scrolling it remotely
 * pointless. Recorded as an attribute on the elements themselves rather than as
 * a list of selectors, so nothing has to be matched up again at the far end.
 */
const SCROLLERS = '.panes, .onboard, .list, .sheet';

function markScroll(live: HTMLElement, clone: HTMLElement): void {
  // Only the handful of containers that can actually scroll. This walked every
  // element in the document twice per tick to begin with, which is a great deal
  // of work every 800ms on a processor thirty times slower than the one it was
  // written on, and all of it to find the two or three that ever scroll.
  const from = live.querySelectorAll(SCROLLERS);
  const to = clone.querySelectorAll(SCROLLERS);
  for (let i = 0; i < from.length && i < to.length; i++) {
    const top = from[i]?.scrollTop ?? 0;
    if (top > 0) to[i]?.setAttribute('data-mirror-scroll', String(Math.round(top)));
  }
}

/** Replaced in the snapshot: cross-origin, unserializable, and large. */
function stripFrames(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  markScroll(root, clone);
  const live = root.querySelectorAll('iframe');
  const copies = clone.querySelectorAll('iframe');

  for (let i = 0; i < copies.length; i++) {
    const original = live[i];
    const copy = copies[i];
    if (!copy || !copy.parentNode) continue;

    // The box is the part worth knowing — every layout problem on this app so
    // far has been about how much room the player was given, never about the
    // picture inside it.
    const box = original ? original.getBoundingClientRect() : null;
    const placeholder = document.createElement('div');
    placeholder.setAttribute('data-mirror-frame', '1');
    placeholder.setAttribute(
      'style',
      'background:#1a1a1a;border:1px dashed #555;color:#888;font:11px sans-serif;' +
        'display:flex;align-items:center;justify-content:center;' +
        (box ? 'width:' + Math.round(box.width) + 'px;height:' + Math.round(box.height) + 'px;' : 'min-height:60px;'),
    );
    placeholder.textContent = box
      ? 'player ' + Math.round(box.width) + '×' + Math.round(box.height)
      : 'player';
    copy.parentNode.replaceChild(placeholder, copy);
  }
  return clone.innerHTML;
}

function text(selector: string): string {
  return (document.querySelector(selector)?.textContent ?? '').trim();
}

export function startMirror(): void {
  if (location.protocol !== 'http:') return;
  installLogging();

  const relay = 'http://' + location.hostname + ':' + RELAY_PORT;
  status.active = true;
  status.relay = relay;
  let previous = '';
  let busy = false;

  const apply = (command: {
    click?: string;
    text?: string;
    reload?: boolean;
    scroll?: { sel?: string; top?: number };
  }): void => {
    try {
      if (command.reload) {
        location.reload();
        return;
      }
      if (command.click) {
        const target = document.querySelector(command.click);
        if (target instanceof HTMLElement) target.click();
      }
      // By what it says on it, which survives a rerender that renumbers
      // everything and is how a person would describe the thing they mean.
      if (command.text) {
        const wanted = command.text.toLowerCase();
        const all = document.querySelectorAll('button, a, .tile, .tab, .seg, .row');
        for (let i = 0; i < all.length; i++) {
          const el = all[i];
          if (el instanceof HTMLElement && (el.textContent ?? '').toLowerCase().indexOf(wanted) >= 0) {
            el.click();
            break;
          }
        }
      }
      if (command.scroll) {
        const el = command.scroll.sel ? document.querySelector(command.scroll.sel) : document.scrollingElement;
        if (el) el.scrollTop = command.scroll.top ?? 0;
      }
    } catch {
      /* a command that does not apply is not worth breaking the tick over */
    }
  };

  const tick = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      // While a track is loading, the device needs every cycle it has: that
      // window is seven seconds of the player's own work on this hardware, and
      // serializing the document alongside it both slows the thing being
      // measured and distorts the measurement. The tick still goes — commands
      // and the timing readout still flow — it just stops carrying the DOM.
      const loading = (document.querySelector('.np-loading')?.textContent ?? '').trim().length > 0;

      const html = loading ? '' : stripFrames(document.body);
      const changed = !loading && html !== previous;
      if (changed) previous = html;

      // An unchanged screen still has to check in. The tick is how commands
      // arrive, and the moment worth sending one is precisely when the device
      // is sitting still — an earlier version skipped the request entirely when
      // nothing had moved, which meant a tap could only ever land on a screen
      // that was already busy changing. Only the DOM is dropped, which is all
      // of the size.
      const res = await fetch(relay + '/snapshot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          html: changed ? html : undefined,
          unchanged: !changed,
          loading,
          title: document.title,
          width: window.innerWidth,
          height: window.innerHeight,
          timing: text('.np-timing'),
          status: text('.np-status'),
          // Ticks since this page loaded. Resets to zero on a reload, which is
          // what makes a reload distinguishable from the screen going to sleep
          // — both look like a gap in the snapshots and only one of them means
          // the device is now running different code.
          sent: status.sent,
          log: log.length > 0 ? log.slice() : undefined,
          // Rough memory pressure, where the browser will say. A renderer that
          // is about to be killed for using too much is otherwise completely
          // silent about it.
          mem: (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory?.usedJSHeapSize,
          // The page's own scroll, which is not an element's scrollTop.
          scrollY: window.pageYOffset || document.documentElement.scrollTop || 0,
          ts: Date.now(),
        }),
      });
      status.lastOkAt = Date.now();
      status.lastError = '';
      status.sent++;
      const reply = (await res.json()) as { commands?: unknown[]; bundle?: number };

      // A rebuild on the other end means this page is running code that has
      // been superseded. Reloading here rather than waiting to be told is what
      // makes a change on the development machine show up on the device without
      // anyone touching it — which on a watch with no keyboard is the whole
      // difference between a usable loop and a miserable one.
      const stamp = reply.bundle ?? 0;
      if (stamp > 0) {
        if (knownBundle === 0) {
          knownBundle = stamp;
        } else if (stamp !== knownBundle && Date.now() - lastReloadAt() > RELOAD_GUARD_MS) {
          // knownBundle is deliberately left alone: if the guard blocks this,
          // the difference is still there next tick and the reload happens as
          // soon as the window passes, rather than being forgotten.
          markReloaded();
          console.info('mirror: bundle changed, reloading');
          location.reload();
          return;
        }
      }

      for (const command of reply.commands ?? []) {
        apply(command as { click?: string; text?: string; reload?: boolean });
      }
      // A command changes the screen, so the next tick must send it.
      if ((reply.commands ?? []).length > 0) previous = '';
    } catch (e) {
      // Not shown as an error anywhere prominent — the relay being down is the
      // normal case — but recorded so Settings can say so when asked.
      status.lastError = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  };

  // Immediately, not after the first interval: the sooner the bundle stamp is
  // known, the smaller the window in which a rebuild can land unnoticed.
  void tick();
  window.setInterval(() => void tick(), TICK_MS);
  console.info('mirror: reporting to ' + relay);
}
