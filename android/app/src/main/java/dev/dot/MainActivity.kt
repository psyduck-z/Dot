package dev.dot

import android.annotation.SuppressLint
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.app.Activity
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import android.content.Context
import java.net.HttpURLConnection
import java.net.URL
import android.webkit.RenderProcessGoneDetail
import java.io.File
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider

/**
 * The whole app is a WebView. The UI, the recommender and the storage all live
 * in the bundled web build; this class exists to host it and to give it an
 * origin it can actually work from.
 *
 * The origin is the reason this is not a two-line `loadUrl("file:///...")`.
 * A `file://` page has an opaque origin, which breaks two things the app needs:
 * the YouTube IFrame player refuses to talk to it over postMessage, and
 * localStorage — which holds the taste model, prefs and catalogue — is
 * unreliable or unavailable. WebViewAssetLoader serves the same bundled files
 * over `https://appassets.androidplatform.net/`, a real, secure origin, while
 * still reading them straight out of the APK's assets.
 *
 * Requests that do not match the asset path fall through untouched, so
 * youtube.com and googleapis.com load normally.
 */
class MainActivity : Activity() {

    private companion object {
        /** Where the app lives when it is not pointed at a development machine. */
        const val PACKAGED = "https://appassets.androidplatform.net/assets/index.html"
        const val KEY_DEV_URL = "devUrl"
        const val KEY_DEV_FAIL = "devFail"
        const val KEY_RETURN_TO = "returnTo"
        const val KEY_DEV_MISSES = "devMisses"
        const val KEY_RENDERER_GONE = "rendererGone"
        /** Consecutive failed loads before the address is given up on. */
        const val DEV_MISS_LIMIT = 3
    }

    private lateinit var webView: WebView
    private var fullscreenView: View? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null
    private lateinit var chromeClient: WebChromeClient
    @Volatile private var keepAwake = false

    /** Where the app should start: a development server if one is set. */
    private fun startUrl(): String {
        val dev = prefs().getString(KEY_DEV_URL, null)
        return if (dev.isNullOrBlank()) PACKAGED else dev
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = buildWebView()
        setContentView(webView)

        // A dev server address, when one has been set, so changes can be tried
        // on the watch without building and installing anything. Plain HTTP and
        // a single origin, which is what lets the page talk to that machine at
        // all: served from appassets it is an HTTPS page, and a request from
        // there to a http:// address on the LAN is mixed content and blocked.
        webView.loadUrl(startUrl())
    }

    /**
     * Builds the WebView. Called again from scratch when the renderer dies,
     * which is why it is a function rather than a block inside onCreate.
     */
    @SuppressLint("SetJavaScriptEnabled")
    private fun buildWebView(): WebView {
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        return WebView(this).apply {
            setBackgroundColor(android.graphics.Color.BLACK)

            settings.javaScriptEnabled = true
            // The app's entire persistence layer is localStorage.
            settings.domStorageEnabled = true
            // Without this the first play() is blocked and the feed never starts,
            // even though the user did tap play — the gesture does not carry
            // through the embedded player.
            settings.mediaPlaybackRequiresUserGesture = false
            settings.loadWithOverviewMode = true
            settings.useWideViewPort = true

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            }

            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest
                ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

                /**
                 * A dev server that is not there must not leave a blank screen.
                 *
                 * This device has no browser, no USB and no way to clear app
                 * data, so a build pointed at a machine that has since been shut
                 * down would be unrecoverable. Every failure to load the main
                 * frame falls back to the packaged app, which turns bricking it
                 * into an inconvenience.
                 *
                 * The address survives the first few failures rather than being
                 * dropped on the first. Restarting the development server, or a
                 * moment of bad wifi, would otherwise unpair the watch
                 * permanently and silently — and reconnecting after exactly
                 * those interruptions is the point of the thing. Three
                 * consecutive misses means the machine is genuinely gone, and
                 * then the address goes.
                 */
                override fun onReceivedError(
                    view: WebView,
                    request: WebResourceRequest,
                    error: android.webkit.WebResourceError
                ) {
                    if (!request.isForMainFrame) return
                    if (view.url?.startsWith("https://appassets.") == true) return

                    val misses = prefs().getInt(KEY_DEV_MISSES, 0) + 1
                    // Recorded so the app can say what happened. Falling back
                    // silently is why a watch that could not reach the laptop
                    // looked exactly like a watch that had never been told to
                    // try, which is a bad half-hour for whoever is guessing.
                    val why = request.url.toString() + " — " + error.description +
                        " (attempt " + misses + " of " + DEV_MISS_LIMIT + ")"
                    val editor = prefs().edit().putString(KEY_DEV_FAIL, why)
                    if (misses >= DEV_MISS_LIMIT) {
                        editor.remove(KEY_DEV_URL).remove(KEY_DEV_MISSES)
                    } else {
                        editor.putInt(KEY_DEV_MISSES, misses)
                    }
                    editor.apply()
                    view.loadUrl(PACKAGED)
                }

                /**
                 * The renderer died. Rebuild rather than go down with it.
                 *
                 * This is what a crash on this device actually is: the system
                 * kills the process rendering the page, usually for memory.
                 * Left unhandled, the WebView stays dead and Android kills the
                 * app along with it — the screen simply stops, which is exactly
                 * what "it crashed" has meant all along, and nothing recovers
                 * because nothing is left running to recover it.
                 *
                 * Returning true claims responsibility, which obliges us to
                 * discard the dead view and build another. The replacement
                 * starts at the same address, so a crash costs a reload rather
                 * than the session.
                 */
                @android.annotation.TargetApi(Build.VERSION_CODES.O)
                override fun onRenderProcessGone(
                    view: WebView,
                    detail: RenderProcessGoneDetail
                ): Boolean {
                    val crashed = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && detail.didCrash()
                    prefs().edit()
                        .putString(
                            KEY_RENDERER_GONE,
                            (if (crashed) "renderer crashed" else "renderer killed to reclaim memory") +
                                " at " + System.currentTimeMillis()
                        )
                        .apply()

                    val last = view.url
                    // The dead view has to leave the hierarchy before it is
                    // destroyed, and be destroyed before another is attached.
                    (view.parent as? ViewGroup)?.removeView(view)
                    view.destroy()

                    webView = buildWebView()
                    setContentView(webView)
                    webView.loadUrl(
                        if (last.isNullOrBlank() || last == "about:blank") startUrl() else last
                    )
                    return true
                }

                /**
                 * A load that worked clears the record of ones that did not, so
                 * three failures have to be consecutive to count.
                 */
                override fun onPageFinished(view: WebView, url: String) {
                    if (url.startsWith("http://")) {
                        prefs().edit().remove(KEY_DEV_MISSES).apply()
                    }
                }
            }

            // The YouTube player asks to go fullscreen; without a chrome client
            // that honours it, the video simply does not expand.
            chromeClient = object : WebChromeClient() {
                override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                    if (fullscreenView != null) {
                        callback.onCustomViewHidden()
                        return
                    }
                    fullscreenView = view
                    fullscreenCallback = callback
                    (window.decorView as ViewGroup).addView(
                        view,
                        FrameLayout.LayoutParams(
                            FrameLayout.LayoutParams.MATCH_PARENT,
                            FrameLayout.LayoutParams.MATCH_PARENT
                        )
                    )
                }

                override fun onHideCustomView() {
                    val view = fullscreenView ?: return
                    (window.decorView as ViewGroup).removeView(view)
                    fullscreenView = null
                    fullscreenCallback?.onCustomViewHidden()
                    fullscreenCallback = null
                }
            }
            webChromeClient = chromeClient
            addJavascriptInterface(DotBridge(), "DotNative")
        }
    }

    private fun prefs() = getSharedPreferences("dot", Context.MODE_PRIVATE)

    /** Result of the most recent reachability probe; empty while it runs. */
    @Volatile private var probeResult = ""

    /** Progress of an APK download, read by the page while it runs. */
    @Volatile private var installState = ""

    /**
     * What the web layer can ask the shell for.
     *
     * Only one thing so far: hold the screen on while music plays, so the
     * watch sleeping does not stop it. Note this keeps the display awake
     * rather than playing with it off — audio continuing behind a hidden
     * player is not something the embedded player's terms allow, and it is
     * the difference between this and a background-playback feature.
     */
    inner class DotBridge {
        /**
         * Brightness for this window only.
         *
         * Deliberately the window attribute rather than the system setting:
         * it needs no permission, it does not change the watch's brightness
         * for anything else, and it reverts the moment the app is left.
         * `level` below zero hands control back to the system.
         */
        @JavascriptInterface
        fun setBrightness(level: Float) {
            runOnUiThread {
                val attrs = window.attributes
                attrs.screenBrightness =
                    if (level < 0f) {
                        WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
                    } else {
                        level.coerceIn(0.01f, 1f)
                    }
                window.attributes = attrs
            }
        }

        /**
         * Which WebView is rendering Dot, and what else is installed that
         * could.
         *
         * Everything slow about this app is the age of the engine: the player
         * costs seven seconds here against one on a desktop, on the same
         * network, and the gap is the thirty-fold difference in how fast the
         * two run JavaScript. A newer provider is the only thing that moves
         * that number, and whether one can be selected at all is a property of
         * the ROM. So report what is active and what is present, rather than
         * leaving it to be guessed at: on most non-GMS builds the candidate
         * list comes back empty and that is the answer.
         *
         * Returns JSON; the framework decides what it will actually accept, so
         * a package appearing here is a candidate and not a promise.
         */
        @JavascriptInterface
        fun webViewInfo(): String {
            val active = try {
                WebViewCompat.getCurrentWebViewPackage(this@MainActivity)
            } catch (e: Throwable) {
                null
            }

            // The package names the platform has ever shipped a provider under,
            // plus the two rebuilds that exist precisely for ROMs without
            // Google's. Installed is not the same as selectable.
            val known = listOf(
                "com.android.webview",
                "com.google.android.webview",
                "com.android.chrome",
                "us.spotco.mulch_wv",
                "org.bromite.webview",
            )
            val others = StringBuilder()
            for (name in known) {
                if (name == active?.packageName) continue
                val version = try {
                    packageManager.getPackageInfo(name, 0).versionName
                } catch (e: Throwable) {
                    null
                } ?: continue
                if (others.isNotEmpty()) others.append(',')
                others.append('"').append(name).append(' ').append(version).append('"')
            }

            return "{\"active\":\"" + (active?.packageName ?: "unknown") +
                "\",\"version\":\"" + (active?.versionName ?: "unknown") +
                "\",\"others\":[" + others + "]}"
        }

        /**
         * Points the app at a dev server, or back at the packaged build.
         *
         * Takes effect on the next launch rather than immediately: reloading
         * out from under the code that asked for it is a good way to lose the
         * setting that was being saved.
         */
        @JavascriptInterface
        fun setDevServer(url: String) {
            val cleaned = url.trim()
            val editor = prefs().edit()
            if (cleaned.isEmpty()) editor.remove(KEY_DEV_URL) else editor.putString(KEY_DEV_URL, cleaned)
            editor.apply()
        }

        @JavascriptInterface
        fun getDevServer(): String = prefs().getString(KEY_DEV_URL, "") ?: ""

        /**
         * Loads the app again, at whatever address is now configured.
         *
         * This called recreate() first, on the reasoning that onCreate is where
         * the address is read. On this firmware recreate() does nothing at all:
         * the page reported "Restarting…", the call was made, and the same page
         * carried on running — confirmed by its tick counter never resetting.
         *
         * Pointing the WebView at the address directly needs no cooperation
         * from the activity lifecycle and is the same outcome. Whether it is
         * worth trusting recreate() on a device this heavily modified is not
         * worth finding out.
         */
        @JavascriptInterface
        fun restartApp() {
            val target = prefs().getString(KEY_DEV_URL, null)
            val url = if (target.isNullOrBlank()) PACKAGED else target
            runOnUiThread { webView.loadUrl(url) }
        }

        /**
         * A note for the app to read after it comes back up.
         *
         * Kept here rather than in localStorage because the whole point of the
         * restart is to change origin, and localStorage does not cross one —
         * a note left by the installed copy is invisible to the dev server.
         */
        @JavascriptInterface
        fun setReturnTo(tag: String) {
            prefs().edit().putString(KEY_RETURN_TO, tag).apply()
        }

        /** Reads the note and clears it, so it acts on exactly one launch. */
        @JavascriptInterface
        fun consumeReturnTo(): String {
            val tag = prefs().getString(KEY_RETURN_TO, "") ?: ""
            if (tag.isNotEmpty()) prefs().edit().remove(KEY_RETURN_TO).apply()
            return tag
        }

        /** Whether the renderer has died, and how, since this was last cleared. */
        @JavascriptInterface
        fun lastRendererCrash(): String = prefs().getString(KEY_RENDERER_GONE, "") ?: ""

        @JavascriptInterface
        fun clearRendererCrash() {
            prefs().edit().remove(KEY_RENDERER_GONE).apply()
        }

        /** Why the last attempt to load from a dev server gave up, if it did. */
        @JavascriptInterface
        fun lastDevFailure(): String = prefs().getString(KEY_DEV_FAIL, "") ?: ""

        @JavascriptInterface
        fun clearDevFailure() {
            prefs().edit().remove(KEY_DEV_FAIL).apply()
        }

        /**
         * Asks whether an address is actually reachable, from the watch.
         *
         * The page cannot find this out for itself: served from appassets it is
         * an HTTPS page, and a request to a http:// address on the LAN is mixed
         * content and blocked before it leaves. The shell has no such problem,
         * so it makes the request and leaves the answer for the page to collect
         * — on a background thread, because a synchronous network call from a
         * bridge method would hang the UI thread and kill the app.
         */
        @JavascriptInterface
        fun probeDevServer(url: String) {
            probeResult = ""
            val target = url.trim()
            Thread {
                probeResult = try {
                    val conn = URL(target).openConnection() as HttpURLConnection
                    conn.connectTimeout = 4000
                    conn.readTimeout = 4000
                    conn.requestMethod = "GET"
                    val code = conn.responseCode
                    conn.disconnect()
                    if (code in 200..399) "ok $code" else "http $code"
                } catch (e: Throwable) {
                    "fail " + (e.message ?: e.javaClass.simpleName)
                }
            }.start()
        }

        /** Empty while a probe is still in flight. */
        @JavascriptInterface
        fun probeStatus(): String = probeResult

        /**
         * This build's versionCode, so the app can tell whether the published
         * APK is newer than the one it is running.
         */
        @JavascriptInterface
        fun appVersionCode(): Int = try {
            packageManager.getPackageInfo(packageName, 0).versionCode
        } catch (e: Throwable) {
            0
        }

        /**
         * Whether the system will let this app ask to install one.
         *
         * Android 8 made this a per-app permission rather than a global switch,
         * and it cannot be granted from inside the app — only in Settings. The
         * page asks first so it can send someone to the right screen instead of
         * firing an intent that silently does nothing.
         */
        /**
         * Whether this build asks for the permission at all.
         *
         * It currently does not: requesting it got the APK blocked as harmful
         * before it could be installed. Reported separately from
         * canInstallApks so the app can hide the offer entirely rather than
         * show a button that sends someone to a settings screen with no switch
         * on it.
         */
        @JavascriptInterface
        fun installSupported(): Boolean = try {
            val declared = packageManager
                .getPackageInfo(packageName, android.content.pm.PackageManager.GET_PERMISSIONS)
                .requestedPermissions
            declared?.any { it == "android.permission.REQUEST_INSTALL_PACKAGES" } == true
        } catch (e: Throwable) {
            false
        }

        @JavascriptInterface
        fun canInstallApks(): Boolean =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                packageManager.canRequestPackageInstalls()
            } else {
                true
            }

        /** Opens the screen where that permission is granted. */
        @JavascriptInterface
        fun openInstallPermission() {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            runOnUiThread {
                try {
                    startActivity(
                        Intent(
                            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            Uri.parse("package:" + packageName)
                        )
                    )
                } catch (e: Throwable) {
                    installState = "fail no settings screen for this permission"
                }
            }
        }

        /**
         * Downloads an APK and hands it to the system installer.
         *
         * The install itself is the system's dialog and the user's decision —
         * installing silently needs privileges a sideloaded app does not have
         * and should not have. What this removes is the part that was actually
         * painful: getting the file onto a watch with no USB and no browser.
         *
         * Written into files/updates, the one directory the FileProvider
         * exposes, and handed over as a content:// URI because a file:// one is
         * refused outright from Android 7 on.
         */
        @JavascriptInterface
        fun installUpdate(url: String) {
            installState = "downloading"
            Thread {
                try {
                    val dir = File(filesDir, "updates")
                    dir.mkdirs()
                    // Replaced rather than accumulated: these are ~1.5MB each
                    // and there is no reason to keep yesterday's.
                    val target = File(dir, "dot-update.apk")
                    if (target.exists()) target.delete()

                    val conn = URL(url).openConnection() as HttpURLConnection
                    conn.connectTimeout = 15000
                    conn.readTimeout = 30000
                    conn.instanceFollowRedirects = true
                    val code = conn.responseCode
                    if (code !in 200..299) {
                        installState = "fail http " + code
                        conn.disconnect()
                        return@Thread
                    }
                    conn.inputStream.use { input ->
                        target.outputStream().use { output -> input.copyTo(output) }
                    }
                    conn.disconnect()

                    // A truncated download would be rejected by the installer
                    // with nothing useful said about why.
                    if (target.length() < 100_000) {
                        installState = "fail download looked incomplete"
                        return@Thread
                    }

                    val uri = FileProvider.getUriForFile(
                        this@MainActivity,
                        packageName + ".files",
                        target
                    )
                    val intent = Intent(Intent.ACTION_VIEW)
                        .setDataAndType(uri, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    installState = "ready"
                    runOnUiThread { startActivity(intent) }
                } catch (e: Throwable) {
                    installState = "fail " + (e.message ?: e.javaClass.simpleName)
                }
            }.start()
        }

        /** Empty until something has happened; then downloading, ready or fail. */
        @JavascriptInterface
        fun installStatus(): String = installState

        @JavascriptInterface
        fun setKeepAwake(on: Boolean) {
            runOnUiThread {
                keepAwake = on
                if (on) {
                    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                } else {
                    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
            }
        }
    }

    override fun onBackPressed() {
        when {
            fullscreenView != null -> chromeClient.onHideCustomView()
            webView.canGoBack() -> webView.goBack()
            else -> super.onBackPressed()
        }
    }

    override fun onPause() {
        super.onPause()
        // Pausing the WebView stops timers and media. That is right for saving
        // battery when nothing is playing, and wrong mid-track, so the web
        // layer says which it is. It still stops when the activity actually
        // goes away; this only covers the screen dimming while music runs.
        if (!keepAwake) webView.onPause()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }
}
