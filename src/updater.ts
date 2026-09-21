/**
 * Over-the-air updates for the web layer.
 *
 * The APK is a WebView around a bundled build, so almost every change to Dot
 * is a change to that bundle, not to the Android shell. Reinstalling an APK to
 * pick up a UI tweak is a lot of ceremony for a file that is tens of
 * kilobytes, so the app can fetch a newer bundle itself and run that instead.
 *
 * The packaged bundle always stays in the APK as the floor: it is what runs on
 * a fresh install, offline, or when a downloaded build turns out to be broken.
 *
 * Safety matters more than cleverness here, because a bad cached bundle on a
 * watch with no browser and no easy file access would be very hard to recover
 * from. So every boot from cache leaves a sentinel behind, and a boot that
 * never finishes clearing it means the cached build is discarded next time.
 * The worst case is falling back to the version that shipped in the APK.
 */

const KEY = {
  bundle: 'dot.ota.bundle.v1',
  version: 'dot.ota.version.v1',
  /** Set before a cached bundle runs, cleared once the app is alive. */
  sentinel: 'dot.ota.booting.v1',
  url: 'dot.ota.url.v1',
} as const;

/**
 * Where updates come from unless told otherwise.
 *
 * Hardcoded rather than left blank because there is exactly one place this
 * app is published from, and making the watch's owner type a URL into a
 * watch-sized text field is a poor trade for configurability nobody wants.
 * The Settings field still overrides it, which is what makes testing a build
 * from somewhere else possible.
 *
 * Served by GitHub Pages from the repository's gh-pages branch. Nothing
 * secret lives there: it is the same compiled bundle that ships in the APK.
 */
export const DEFAULT_UPDATE_URL = 'https://psyduck-z.github.io/Dot/version.json';

declare const __DOT_VERSION__: string;
export const BUILD_VERSION = typeof __DOT_VERSION__ === 'string' ? __DOT_VERSION__ : 'dev';

export interface UpdateManifest {
  version: string;
  /** Absolute or relative to the manifest. */
  bundle: string;
  notes?: string;
}

export interface UpdateStatus {
  current: string;
  available?: string;
  notes?: string;
  message: string;
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage full or blocked; the app keeps running on the packaged build */
  }
}

function remove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* nothing useful to do */
  }
}

/** Where to look for updates: the Settings override, else the default. */
export function updateUrl(): string {
  return (read(KEY.url) ?? '').trim() || DEFAULT_UPDATE_URL;
}

/** True when the Settings field is empty and the built-in URL is in use. */
export function usingDefaultUpdateUrl(): boolean {
  return !(read(KEY.url) ?? '').trim();
}

export function setUpdateUrl(url: string): void {
  write(KEY.url, url.trim());
}

/** The version actually running, which may be a downloaded one. */
export function runningVersion(): string {
  return read(KEY.version) ?? BUILD_VERSION;
}

export function isRunningDownloaded(): boolean {
  return read(KEY.version) !== null && read(KEY.bundle) !== null;
}

/**
 * Called once the app has successfully started. Clearing the sentinel is what
 * marks the cached bundle as trustworthy; a build that crashes before this
 * point is discarded on the next launch.
 */
export function markBootSuccessful(): void {
  remove(KEY.sentinel);
}

function resolve(base: string, path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return base.replace(/\/[^/]*$/, '/') + path.replace(/^\.?\//, '');
}

/**
 * Checks for a newer build and installs it if there is one. Returns what to
 * tell the user; it never throws, because an update check failing is not
 * something that should interrupt playback.
 */
export async function checkForUpdate(): Promise<UpdateStatus> {
  const current = runningVersion();
  const url = updateUrl();

  let manifest: UpdateManifest;
  try {
    // Cache-busted: an update check that reads a cached manifest is useless.
    const res = await fetch(url + (url.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now(), {
      cache: 'no-store',
    });
    if (!res.ok) return { current, message: 'Update server returned ' + res.status + '.' };
    manifest = (await res.json()) as UpdateManifest;
  } catch {
    return { current, message: 'Could not reach the update server.' };
  }

  if (!manifest?.version || !manifest.bundle) {
    return { current, message: 'That URL did not return a valid manifest.' };
  }
  if (manifest.version === current) {
    return { current, message: 'Up to date.' };
  }

  let code: string;
  try {
    const res = await fetch(resolve(url, manifest.bundle), { cache: 'no-store' });
    if (!res.ok) return { current, message: 'Could not download the update.' };
    code = await res.text();
  } catch {
    return { current, message: 'Could not download the update.' };
  }

  // A truncated download would brick the app on next boot, and the sentinel
  // would only catch it after one failed launch. Cheap to check here instead.
  if (code.length < 1000) {
    return { current, message: 'The downloaded update looked incomplete.' };
  }

  write(KEY.bundle, code);
  write(KEY.version, manifest.version);

  return {
    current,
    available: manifest.version,
    notes: manifest.notes,
    message: 'Updated to ' + manifest.version + '. Restart Dot to use it.',
  };
}
