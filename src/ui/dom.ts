/**
 * DOM helpers.
 *
 * No framework: five screens and a few hundred nodes do not justify shipping a
 * virtual DOM to a watch running an eight-year-old WebView.
 */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(className: string, text?: string, label?: string): HTMLButtonElement {
  const node = el('button', className, text);
  node.type = 'button';
  if (label) node.setAttribute('aria-label', label);
  return node;
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}

/**
 * Deterministic colour per string, for tiles that have no artwork.
 * Fixed saturation and lightness keep the set looking like one palette rather
 * than a random assortment.
 */
export function tintFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return 'hsl(' + h + ', 48%, 32%)';
}

/**
 * Rewrites a YouTube thumbnail to a smaller variant.
 *
 * The API hands back hqdefault (480x360) for everything. Painting that into a
 * 46px row costs the full download for a hundredth of the pixels, which on a
 * slow radio is the difference between a list appearing and a list crawling.
 */
export function ytThumb(url: string | undefined, size: 'default' | 'mq' | 'hq'): string | undefined {
  if (!url) return undefined;
  const wanted = size === 'hq' ? 'hqdefault' : size === 'mq' ? 'mqdefault' : 'default';
  return url.replace(/\/(default|mqdefault|hqdefault|sddefault|maxresdefault)\.jpg/, '/' + wanted + '.jpg');
}

/**
 * Defers image loading until the element is near the viewport.
 *
 * A thirty-row list otherwise fires thirty image requests at once, all
 * competing with the track the user is actually waiting for. IntersectionObserver
 * is Chrome 51, comfortably below the target; where it is missing the image
 * simply loads immediately, which is the old behaviour.
 */
let artObserver: IntersectionObserver | null = null;
const pendingArt = new WeakMap<Element, string>();

function observer(): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null;
  if (!artObserver) {
    artObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const url = pendingArt.get(entry.target);
          if (url) {
            (entry.target as HTMLElement).style.backgroundImage = 'url("' + url + '")';
            pendingArt.delete(entry.target);
          }
          artObserver?.unobserve(entry.target);
        }
      },
      // Start fetching just before a row scrolls into view.
      { rootMargin: '200px' },
    );
  }
  return artObserver;
}

/**
 * Empties a container, releasing any lazy artwork inside it first.
 *
 * This matters more than it looks. The image observer only lets go of a node
 * once that node scrolls into view; anything discarded before then stays
 * observed, and an observer holds its targets strongly. Lists here are rebuilt
 * on every track change, so without this each rebuild left another dozen
 * detached nodes behind, and every later callback had more of them to walk.
 */
export function clear(node: HTMLElement): void {
  if (artObserver) {
    const pending = node.querySelectorAll('*');
    for (let i = 0; i < pending.length; i++) {
      const child = pending[i]!;
      if (pendingArt.has(child)) {
        artObserver.unobserve(child);
        pendingArt.delete(child);
      }
    }
  }
  node.textContent = '';
}

/** Sets background artwork, falling back to a tinted placeholder. */
export function paintArt(
  node: HTMLElement,
  url: string | undefined,
  seed: string,
  glyph = '♪',
  lazy = false,
): void {
  if (!url) {
    node.style.backgroundImage = '';
    node.style.backgroundColor = tintFor(seed);
    node.textContent = glyph;
    return;
  }

  // A tint underneath means the row has its shape and colour before the image
  // arrives, rather than a grey hole.
  node.style.backgroundColor = tintFor(seed);
  node.textContent = '';

  const io = lazy ? observer() : null;
  if (io) {
    node.style.backgroundImage = '';
    pendingArt.set(node, url);
    io.observe(node);
  } else {
    node.style.backgroundImage = 'url("' + url + '")';
  }
}
