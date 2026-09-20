/**
 * Runtime polyfills for old Android WebViews.
 *
 * esbuild lowers syntax to the target, but it never adds missing APIs. These are
 * the gaps that actually bite on Chromium 55-61, kept hand-written and tiny
 * rather than pulling in core-js, which would dwarf the app itself.
 *
 * Must be imported first, before any module that might use these at load time.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any;

// Chrome 66.
if (typeof g.AbortController === 'undefined') {
  g.AbortController = class AbortControllerPolyfill {
    signal = { aborted: false, addEventListener() {}, removeEventListener() {} };
    abort(): void {
      this.signal.aborted = true;
    }
  };
}

// Chrome 73.
if (typeof Object.fromEntries !== 'function') {
  Object.fromEntries = function fromEntries(entries: Iterable<readonly [PropertyKey, unknown]>) {
    const out: Record<PropertyKey, unknown> = {};
    for (const [k, v] of entries as Iterable<[PropertyKey, unknown]>) out[k] = v;
    return out;
  } as typeof Object.fromEntries;
}

// Chrome 69.
if (typeof Array.prototype.flat !== 'function') {
  Object.defineProperty(Array.prototype, 'flat', {
    configurable: true,
    writable: true,
    value: function flat(this: unknown[], depth = 1): unknown[] {
      const out: unknown[] = [];
      for (const item of this) {
        if (Array.isArray(item) && depth > 0) out.push(...(item as unknown[]).flat(depth - 1));
        else out.push(item);
      }
      return out;
    },
  });
}

if (typeof Array.prototype.flatMap !== 'function') {
  Object.defineProperty(Array.prototype, 'flatMap', {
    configurable: true,
    writable: true,
    value: function flatMap(this: unknown[], fn: (v: unknown, i: number, a: unknown[]) => unknown) {
      return this.map(fn).flat(1);
    },
  });
}

// Chrome 85.
if (typeof String.prototype.replaceAll !== 'function') {
  Object.defineProperty(String.prototype, 'replaceAll', {
    configurable: true,
    writable: true,
    value: function replaceAll(this: string, search: string, replacement: string): string {
      return this.split(search).join(replacement);
    },
  });
}

// Chrome 76.
if (typeof Promise !== 'undefined' && typeof (Promise as any).allSettled !== 'function') {
  (Promise as any).allSettled = function allSettled(promises: Array<Promise<unknown>>) {
    return Promise.all(
      promises.map((p) =>
        Promise.resolve(p).then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (reason) => ({ status: 'rejected' as const, reason }),
        ),
      ),
    );
  };
}

export {};
