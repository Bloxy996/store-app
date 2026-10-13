plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.bloxy996.storesparks"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.bloxy996.storesparks"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    // CI signs every build with one fixed key (repo secrets, see deploy.yml) so a
    // new APK installs over the old one. Without the env vars (local builds)
    // Gradle's default debug key is used.
    signingConfigs {
        val keystore = System.getenv("ANDROID_KEYSTORE_FILE")?.let { file(it) }
        if (keystore != null && keystore.exists()) {
            create("fixed") {
                storeFile = keystore
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = "sparks"
                keyPassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            signingConfigs.findByName("fixed")?.let { signingConfig = it }
        }
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
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
    // Custom Tabs: the floating capture sheet (SparkCaptureActivity). Small,
    // and the only dependency — no AppCompat/Material/WebView wrapper.
    implementation("androidx.browser:browser:1.8.0")
}
