package com.bloxy996.storesparks

import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.service.quicksettings.TileService

// ---------------------------------------------------------------------------
// A plain "open the capture form" shortcut, reachable with two swipes down
// from inside any app — same idea as the widget, just living in the Quick
// Settings shade instead of the home screen. Unlike an earlier version of
// this file, it no longer toggles anything: the floating bubble is now
// SparkAccessibilityService (Android's own accessibility button), which
// is switched on/off from Settings → Accessibility, not from here.
// ---------------------------------------------------------------------------
class SparkTileService : TileService() {

    override fun onClick() {
        super.onClick()
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(SPARK_CAPTURE_URL))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

        // startActivityAndCollapse(Intent) was deprecated in API 34 in
        // favor of the PendingIntent overload; branch to keep both the
        // minSdk and targetSdk happy.
        if (Build.VERSION.SDK_INT >= 34) {
            val pending = PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE)
            startActivityAndCollapse(pending)
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }
}
