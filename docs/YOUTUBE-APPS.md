# The YouTube apps on the watch

Two different things wear a YouTube logo on this device, and they are easy to
confuse. This note pins down which is which, from the actual APK metadata.

## The file in Downloads is official YouTube for TV — not "YouTube Lite"

`/sdcard/Download/_ac65ccc8.xapk` (≈74 MB, an APKPure `.xapk` bundle) was
assumed to be the custom "YouTube Lite". **It is not.** Its base APK's manifest
identifies it unambiguously as **Google's own YouTube for Android TV**:

| | |
|---|---|
| Package | **`com.google.android.youtube.tv`** |
| Main activity | `com.google.android.apps.youtube.tv.activity.MainActivity` |
| Launcher category | `android.intent.category.LEANBACK_LAUNCHER` (a TV app) |
| Engine | **Cobalt** — `assets/cobalt_shell.pak`, `icudtl.dat` (Google's YouTube-for-TV runtime) |
| Build stamp seen | version string `7.28.300` in the manifest |
| Signing/components | genuine Google: Firebase, GMS, Play Billing, Cast-TV |

Its permissions are exactly what the real YouTube TV app requests and nothing
sinister:

```
INTERNET, ACCESS_NETWORK_STATE, ACCESS_WIFI_STATE, WAKE_LOCK,
RECORD_AUDIO + android.hardware.microphone   (voice search),
MODIFY_AUDIO_SETTINGS, RECEIVE_BOOT_COMPLETED, BIND_JOB_SERVICE,
com.android.vending.billing (Play Billing), cast.tv.*, tv.READ/WRITE_EPG_DATA,
gms.permission.AD_ID
```

So the icon looks like YouTube because it **is** YouTube — the official TV
edition, sideloaded from APKPure. There is nothing to be wary of here; it is
Google's app.

## "YouTube Lite" is a WebView wrapper around youtube.com

The thing the launcher labels **"YouTube Lite"** is a separate package,
`com.YouTube.iT`. It was obtained via CX's own "Backup" feature (which writes an
installed app's APK to `/sdcard` with no root — the APK then came over the FTP
share) and decompiled. It is **not** a Google package, but it is also **not**
malicious: it is a hobbyist **WebView wrapper that loads
`https://www.youtube.com/`** and nothing more.

| | |
|---|---|
| Package | **`com.YouTube.iT`** |
| Version | 1.0 (versionCode 1), built 2021-04-20, targetSdk 30 |
| Main activity | `com.YouTube.iT.MainActivity` |
| Built with | **Sketchware** (classes `SketchwareUtil`, `RequestNetwork`) — a drag-and-drop "website → APK" maker |
| Own code | 6 classes: `MainActivity`, `OfflineActivity`, `DebugActivity`, `R`, `RequestNetwork`, `SketchwareUtil` |
| WebView plumbing | one `loadUrl`, `setJavaScriptEnabled`, `WebChromeClient`, `CookieManager`, `onDownloadStart`→`DownloadManager` |
| One bundled asset | a Lottie "no internet" animation (the offline screen) |

What the decompile shows about safety — it comes out clean:

| Check | Result |
|---|---|
| Permissions | **only** `INTERNET` + `ACCESS_NETWORK_STATE` |
| Network endpoints | `www.youtube.com` (the site) and `www.google.com` (connectivity ping) — nothing else |
| Ad / analytics / tracking SDKs | none (doubleclick, firebase, crashlytics, appsflyer, facebook, admob, flurry, umeng all absent) |
| Hardcoded secrets / tokens | none (the `password*` strings are stock Material text-field attributes) |
| Native code (`.so`) | none |
| JS→native bridge (`addJavascriptInterface`) | **none** — the page cannot call into the app |
| Mic / camera / location / contacts / SMS / storage-read | cannot — not permitted, so unreachable regardless of code |

So the icon imitates YouTube because the author pointed a WebView at youtube.com
and named the package to match. The odd capitalisation (`com.YouTube.iT`) and
version `1.0` are just how that hobbyist packaged it, not a sign of anything
hostile. Functionally it is "youtube.com in a box" — and because it is a WebView
it runs on the same frozen Chromium 74 described in `DEVICE.md`, so it inherits
all of that engine's slowness and buys nothing over opening the site directly.

## Local copies

Neither third-party APK is committed (both are large binaries, and
`vendor-apks/` is gitignored). The decompiled `com.YouTube.iT` was examined from
a scratch copy and not kept in the repo; the official YouTube-TV bundle is no
longer stored locally either. Only these notes remain.
