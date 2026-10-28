package dev.dot.ytfast

import android.annotation.SuppressLint
import android.app.Activity
import android.app.DownloadManager
import android.content.Context
import android.net.ConnectivityManager
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.view.Gravity
import android.view.View
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast

/**
 * A leaner re-build of the watch's preinstalled "YouTube Lite"
 * (com.YouTube.iT), which was a Sketchware-generated WebView wrapper around
 * https://www.youtube.com/. This loads the same mobile YouTube site in one
 * WebView, but strips out the things that made the original lag on this device:
 *
 *   1. No per-tick connectivity probe. The original fired an HTTP GET to
 *      google.com on *every* onProgressChanged, onPageStarted, onPageFinished
 *      and after every download — many network round-trips and threads per page,
 *      all competing with an already-slow Chromium 74. Here connectivity is read
 *      locally and instantly from ConnectivityManager, and only consulted when a
 *      load actually fails.
 *   2. Caching left on (DOM storage + the WebView's own disk cache) so a cold
 *      start re-uses what it fetched last time instead of re-downloading.
 *   3. CSS animations and transitions forced to run instantly, so the compositor
 *      is not repainting tweened frames on a weak GPU while you scroll.
 *   4. The page is shown as it paints behind a thin top progress bar, instead of
 *      being hidden behind a full-screen overlay until onPageFinished.
 *   5. Goes straight to m.youtube.com, skipping the www -> m redirect hop.
 *
 * None of this makes Chromium 74 faster at running YouTube's JavaScript — that
 * is the real ceiling (docs/DEVICE.md). This is "a bit faster / less laggy",
 * not a different engine.
 */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private lateinit var progress: ProgressBar
    private lateinit var offline: TextView

    companion object {
        // The one URL this app exists to show. m.youtube.com is the phone site;
        // loading it directly avoids the extra redirect www.youtube.com makes on
        // a mobile WebView. Change this one line to point the app elsewhere.
        private const val START_URL = "https://m.youtube.com/"

        // Force every animation/transition to finish in ~1ms. We shorten rather
        // than remove them (animation:none can strand elements on an opacity:0
        // opening keyframe and hide content) — a 1ms duration snaps straight to
        // the final frame, so content still appears, minus the per-frame paint
        // churn that janks scrolling on this GPU. Injected once; it survives
        // YouTube's in-app (SPA) navigations because it lives in <head>.
        private const val TRIM_CSS =
            "*,*::before,*::after{" +
                "animation-duration:1ms!important;animation-delay:0ms!important;" +
                "transition-duration:1ms!important;transition-delay:0ms!important}" +
            "html{scroll-behavior:auto!important}"

        private val INJECT_JS = """
            (function(){
              if(document.getElementById('dot_trim'))return;
              var s=document.createElement('style');
              s.id='dot_trim';
              s.textContent=${jsString(TRIM_CSS)};
              (document.head||document.documentElement).appendChild(s);
            })();
        """.trimIndent()

        private fun jsString(raw: String): String =
            "\"" + raw.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val frame = FrameLayout(this)

        web = WebView(this)
        frame.addView(
            web,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )

        // A slim determinate bar pinned to the top, shown only while loading.
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal)
        progress.max = 100
        val barHeight = (3 * resources.displayMetrics.density).toInt()
        frame.addView(
            progress,
            FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, barHeight),
        )

        // Hidden until a load fails with no network; tap to retry.
        offline = TextView(this)
        offline.text = "Offline — tap to retry"
        offline.gravity = Gravity.CENTER
        offline.textSize = 15f
        offline.setBackgroundColor(0xEE000000.toInt())
        offline.setTextColor(0xFFFFFFFF.toInt())
        offline.visibility = View.GONE
        offline.setOnClickListener {
            offline.visibility = View.GONE
            web.reload()
        }
        frame.addView(
            offline,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )

        setContentView(frame)
        configureWebView()

        // Restore the back/forward stack after process death; otherwise cold-load
        // the site. (Config changes don't recreate us — see android:configChanges.)
        val restored = savedInstanceState != null && web.restoreState(savedInstanceState) != null
        if (!restored) web.loadUrl(START_URL)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        val s = web.settings
        s.javaScriptEnabled = true          // YouTube does not render without it
        s.domStorageEnabled = true          // the site relies on it; also caches
        s.databaseEnabled = true
        s.loadsImagesAutomatically = true
        s.cacheMode = WebSettings.LOAD_DEFAULT        // reuse the disk cache
        s.useWideViewPort = true                      // respect the page viewport
        s.loadWithOverviewMode = true                 // fit the 320px-wide screen
        s.mediaPlaybackRequiresUserGesture = false    // a tap starts playback directly
        s.javaScriptCanOpenWindowsAutomatically = false
        s.setSupportMultipleWindows(false)
        s.builtInZoomControls = false                 // pinch-zoom is awkward at watch size
        s.displayZoomControls = false

        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)

        web.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                // Drive the bar only. No google.com probe — that was the
                // original's main per-tick waste.
                progress.progress = newProgress
                progress.visibility = if (newProgress >= 100) View.GONE else View.VISIBLE
            }
        }

        web.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String?) {
                progress.visibility = View.GONE
                offline.visibility = View.GONE
                view.evaluateJavascript(INJECT_JS, null)
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError,
            ) {
                // Only react to the main document failing, and only treat it as
                // "offline" when the device really has no network — otherwise a
                // single failed sub-resource would throw up the retry screen.
                if (request.isForMainFrame && !isOnline()) {
                    offline.visibility = View.VISIBLE
                }
            }
        }

        // Keep YouTube's own download links working, and carry the login cookie
        // so an authenticated download still succeeds (parity with the original).
        web.setDownloadListener { url, _, contentDisposition, mimeType, _ ->
            try {
                val req = DownloadManager.Request(Uri.parse(url))
                CookieManager.getInstance().getCookie(url)?.let { req.addRequestHeader("cookie", it) }
                val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
                req.setTitle(name)
                req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
                (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(req)
                Toast.makeText(this, "Downloading $name", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Toast.makeText(this, "Download failed: ${e.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun isOnline(): Boolean {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
        // getActiveNetworkInfo is deprecated but is the simplest correct check on
        // API 27 (this watch), and costs nothing — no network request, unlike the
        // original's google.com GET.
        return cm.activeNetworkInfo?.isConnected == true
    }

    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onPause() {
        super.onPause()
        web.onPause()
        web.pauseTimers()   // stop background JS timers eating CPU when not shown
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        web.resumeTimers()
    }

    override fun onDestroy() {
        // Detach and destroy so the WebView does not leak the Activity.
        (web.parent as? FrameLayout)?.removeView(web)
        web.destroy()
        super.onDestroy()
    }
}
