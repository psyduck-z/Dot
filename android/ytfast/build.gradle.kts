plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/*
 * A faster re-build of the watch's preinstalled "YouTube Lite" (com.YouTube.iT),
 * which decompiled to a Sketchware WebView wrapper around https://www.youtube.com/.
 * Same idea — the mobile YouTube site in a full-screen WebView — but with the
 * waste taken out: it does not fire a google.com probe on every single progress
 * tick (the original did, which steals CPU and threads from an already-slow
 * Chromium 74), it caches so a cold start pays the download once, it kills CSS
 * animations/transitions that jank the compositor on this GPU, and it shows the
 * page as it paints instead of hiding it behind a full-screen overlay until load
 * finishes. It cannot make Chromium 74 faster at JavaScript — that is the real
 * ceiling (see docs/DEVICE.md) — so this is an incremental "less laggy", not a
 * transformation.
 *
 * Its own package (dev.dot.ytfast), not com.YouTube.iT: a different app, signed
 * with our key, installed alongside. Reverting is uninstalling this one app.
 */
android {
    namespace = "dev.dot.ytfast"
    compileSdk = 34

    defaultConfig {
        applicationId = "dev.dot.ytfast"
        minSdk = 21
        targetSdk = 34
        versionCode = (System.getenv("DOT_VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("DOT_VERSION_NAME") ?: "0.1.0"
    }

    signingConfigs {
        // The same repo debug key the Dot app and the probe use: a stable
        // certificate so updates install over each other, and a release build
        // rather than a debuggable one so Play Protect objects less.
        getByName("debug") {
            storeFile = rootProject.file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        getByName("debug") { signingConfig = signingConfigs.getByName("debug") }
        getByName("release") {
            signingConfig = signingConfigs.getByName("debug")
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    // Same local-SDK path quirk as the probe module; the release lint gate was
    // failing on that rather than on anything in the code.
    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
}

dependencies {}
