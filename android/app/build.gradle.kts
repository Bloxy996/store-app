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

    buildTypes {
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

// No dependencies{} block on purpose — see the file header. Total runtime
// footprint of this app is: one Kotlin class, two tiny XML resources, and
// whatever the AGP/Kotlin stdlib baseline costs (a few hundred KB), not
// several MB of AndroidX/Material/WebView-wrapper libraries.
