package com.bloxy996.storesparks

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews

// ---------------------------------------------------------------------------
// The widget has no logic of its own beyond "open this URL": no capture
// form, no Drive calls, no auth. Tapping it fires a plain ACTION_VIEW
// intent, which Android hands to whatever's registered for that URL — the
// user's default browser, or the installed PWA itself if it's set as the
// verified handler. Either way it's the SAME session (same cookies) the
// user already has from using the app normally, and the SAME capture form
// used inline in the Sparks panel (SparkCaptureForm.jsx) — this widget
// doesn't duplicate that UI, it just gets the user to it one tap faster.
//
// See SparkConfig.kt for SPARK_CAPTURE_URL (shared with OverlayService),
// and android/README.md for how this relates to the overlay bubble and
// the quick settings tile — three entry points into the same one route.
// ---------------------------------------------------------------------------
class SparkWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        val launchIntent = Intent(Intent.ACTION_VIEW, Uri.parse(SPARK_CAPTURE_URL))
        val pendingIntent = PendingIntent.getActivity(
            context,
            0,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        for (widgetId in appWidgetIds) {
            val views = RemoteViews(context.packageName, R.layout.spark_widget)
            views.setOnClickPendingIntent(R.id.spark_widget_root, pendingIntent)
            appWidgetManager.updateAppWidget(widgetId, views)
        }
    }
}
