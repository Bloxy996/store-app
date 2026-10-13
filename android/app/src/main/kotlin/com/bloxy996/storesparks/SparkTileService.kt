package com.bloxy996.storesparks

import android.app.PendingIntent
import android.os.Build
import android.service.quicksettings.TileService

// "Add spark" shortcut in the Quick Settings shade: collapses the shade and
// opens the floating capture sheet (SparkCaptureActivity) over the current app.
// ---------------------------------------------------------------------------
class SparkTileService : TileService() {

    override fun onClick() {
        super.onClick()
        val intent = captureIntent()
        // startActivityAndCollapse(Intent) was deprecated in API 34 in
        // favor of the PendingIntent overload; branch to keep both the
        // minSdk and targetSdk happy.
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE))
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }
}
