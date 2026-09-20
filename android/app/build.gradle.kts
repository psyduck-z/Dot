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

    buildTypes {
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
