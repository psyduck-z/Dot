plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.dot"
    compileSdk = 34

    defaultConfig {
        applicationId = "dev.dot"
        // 21 rather than Capacitor's 24: these watches run Android 7/8, and a
        // hand-rolled shell has no floor of its own to respect.
        minSdk = 21
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    signingConfigs {
        /*
         * A debug keystore kept in the repository, so every build is signed
         * with the same key.
         *
         * Without this, Gradle mints a throwaway keystore on whatever machine
         * is building, and CI gets a fresh one every run — three consecutive
         * builds here carried three different certificates. Android will not
         * install an APK over an app signed with a different key, so each new
         * build silently could not be installed over the last one, and the only
         * way to take an update was to uninstall and lose everything the app
         * had stored. That is a miserable way to ship to a watch.
         *
         * This is not a secret. It is the conventional Android debug key, with
         * the conventional password, and it protects nothing — anyone can
         * generate an equivalent one. It exists so that updates install.
         * Release builds are signed separately and do not use it.
         */
        getByName("debug") {
            storeFile = rootProject.file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("debug")
        }
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // The only dependency. WebViewAssetLoader is what lets the app serve its
    // own files over https instead of file://, which the YouTube IFrame player
    // requires — see MainActivity.
    implementation("androidx.webkit:webkit:1.11.0")
}
