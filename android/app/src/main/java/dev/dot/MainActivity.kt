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

    private lateinit var webView: WebView
    private var fullscreenView: View? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null
    private lateinit var chromeClient: WebChromeClient
    @Volatile private var keepAwake = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this).apply {
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
        }

        webView.addJavascriptInterface(DotBridge(), "DotNative")
        setContentView(webView)
        webView.loadUrl("https://appassets.androidplatform.net/assets/index.html")
    }

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
