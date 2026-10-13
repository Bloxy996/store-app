package com.bloxy996.storesparks

import android.content.Context
import android.content.Intent

// EDIT ME if you move hosts. Must match where the PWA is deployed.
const val SPARK_APP_URL = "https://store-app-blxy.vercel.app/"

// `?embed=spark` renders only the capture form (src/features/sparks/
// SparkQuickCapture.jsx) — that's what the floating sheet shows.
const val SPARK_CAPTURE_URL = "${SPARK_APP_URL}?embed=spark"

// The one way every entry point (widget, tile, accessibility button,
// launcher screen) opens the capture sheet.
fun Context.captureIntent(): Intent =
    Intent(this, SparkCaptureActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
