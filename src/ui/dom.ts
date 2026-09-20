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

export function clear(node: HTMLElement): void {
  node.textContent = '';
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

/** Sets background artwork, falling back to a tinted placeholder. */
export function paintArt(node: HTMLElement, url: string | undefined, seed: string, glyph = '♪'): void {
  if (url) {
    node.style.backgroundImage = 'url("' + url + '")';
    node.style.backgroundColor = '#1e1e1e';
    node.textContent = '';
  } else {
    node.style.backgroundImage = '';
    node.style.backgroundColor = tintFor(seed);
    node.textContent = glyph;
  }
}
