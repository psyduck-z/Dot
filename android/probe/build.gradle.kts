plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/*
 * A separate app from Dot (applicationId dev.dot.probe), on purpose. It answers
 * questions about the watch that can only be answered by code running on it —
 * the real sensor list, the display density, the heap cap, which key events an
 * ordinary app actually receives — and it demonstrates a double-tap-anywhere
 * gesture without touching Dot. Reverting is uninstalling this one app; nothing
 * it does reaches dev.dot or the system.
 */
android {
    namespace = "dev.dot.probe"
    compileSdk = 34

    defaultConfig {
        applicationId = "dev.dot.probe"
        minSdk = 21
        targetSdk = 34
        versionCode = (System.getenv("DOT_VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("DOT_VERSION_NAME") ?: "0.1.0"
    }

    signingConfigs {
        // The same repo debug key the Dot app uses, for the same reason: a
        // stable certificate so updates install over each other, and a release
        // build rather than a debuggable one so Play Protect objects less.
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

    // A throwaway diagnostic build does not need the release lint gate, and it
    // was failing on a path-syntax quirk of this local SDK layout rather than
    // on anything in the code.
    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
}

dependencies {}
