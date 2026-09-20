package dev.dot

import android.annotation.SuppressLint
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
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

        setContentView(webView)
        webView.loadUrl("https://appassets.androidplatform.net/assets/index.html")
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
        // Without this the page keeps running with the screen off and drains the
        // battery. Real background audio needs a foreground service, which the
        // YouTube path cannot use anyway — its terms require a visible player.
        webView.onPause()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }
}
