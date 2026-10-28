# YT Fast — a leaner YouTube WebView for the watch

A re-build of the watch's preinstalled **"YouTube Lite"** (`com.YouTube.iT`),
which decompiled to a Sketchware-generated WebView wrapper around
`https://www.youtube.com/` (see [`docs/YOUTUBE-APPS.md`](../../docs/YOUTUBE-APPS.md)
for the teardown). Same idea — the mobile YouTube site in one full-screen
WebView — with the waste that made it lag taken out.

## What's different from the original

| | Original `com.YouTube.iT` | This (`dev.dot.ytfast`) |
|---|---|---|
| Connectivity check | HTTP GET to `google.com` on **every** progress tick, page start, page finish, and after each download | Read locally from `ConnectivityManager`, only when a load actually fails — **no network round-trips** |
| Caching | not configured | DOM storage + WebView disk cache left on, so a cold start reuses the last fetch |
| Animations | full YouTube animation/transition work | forced to finish in ~1 ms, cutting per-frame paint/composite jank while scrolling |
| Loading UI | hides the whole WebView behind an overlay until `onPageFinished` | thin top progress bar; the page shows as it paints |
| First URL | `www.youtube.com` (redirects to `m.`) | `m.youtube.com` directly, one less hop |
| Base class | `AppCompatActivity` (+ AndroidX) | plain `Activity`, no AndroidX — smaller, fewer classes to load |

Permissions are identical to the original and minimal: `INTERNET` +
`ACCESS_NETWORK_STATE`. No storage-read, mic, camera, or location.

## The honest ceiling

None of this makes **Chromium 74** faster at running YouTube's JavaScript, and
that engine is where most of the slowness lives (see
[`docs/DEVICE.md`](../../docs/DEVICE.md)). So expect "a bit snappier, less janky",
not a different class of device. The biggest real win is dropping the constant
`google.com` probing, which freed CPU and threads the original spent while you
were trying to scroll.

**Not yet measured on-device.** The watch's FTP access was taken down before
this could be installed and timed. The claims above are mechanism-level
reasoning, not measured deltas — confirm them on the watch before trusting them.

## Build

```
cd android
gradle :ytfast:assembleRelease
```

Output: `android/ytfast/build/outputs/apk/release/ytfast-release.apk`, signed
with the repo debug key (stable certificate, same as `:app` and `:probe`).
Sideload that; revert by uninstalling `dev.dot.ytfast`. It installs **alongside**
the original — different package name, so it does not replace or impersonate it.

## Reference

`reference/youtube-lite-original-1.0.apk` is the untouched original, pulled from
the watch (via CX's "Backup", which copies an installed APK to storage with no
root) and kept here so the re-build can always be diffed against what it came
from.
