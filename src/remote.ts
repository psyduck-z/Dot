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

/** Replaced in the snapshot: cross-origin, unserializable, and large. */
function stripFrames(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
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

  const relay = 'http://' + location.hostname + ':' + RELAY_PORT;
  let previous = '';
  let busy = false;

  const apply = (command: { click?: string; text?: string; scroll?: { sel?: string; top?: number } }): void => {
    try {
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
      const html = stripFrames(document.body);
      const changed = html !== previous;
      previous = html;

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
          title: document.title,
          width: window.innerWidth,
          height: window.innerHeight,
          timing: text('.np-timing'),
          status: text('.np-status'),
          ts: Date.now(),
        }),
      });
      const reply = (await res.json()) as { commands?: unknown[] };
      for (const command of reply.commands ?? []) apply(command as { click?: string; text?: string });
      // A command changes the screen, so the next tick must send it.
      if ((reply.commands ?? []).length > 0) previous = '';
    } catch {
      // The relay not being up is the normal case, not an error worth showing.
    } finally {
      busy = false;
    }
  };

  window.setInterval(() => void tick(), TICK_MS);
  console.info('mirror: reporting to ' + relay);
}
