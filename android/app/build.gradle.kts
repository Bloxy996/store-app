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

dependencies {
    // Custom Tabs: the floating capture sheet (SparkCaptureActivity). Small,
    // and the only dependency — no AppCompat/Material/WebView wrapper.
    implementation("androidx.browser:browser:1.8.0")
}
