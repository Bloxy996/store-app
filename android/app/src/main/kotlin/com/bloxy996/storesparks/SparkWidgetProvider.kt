package com.bloxy996.storesparks

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.widget.RemoteViews

// The widget is a "tap to add" bar: RemoteViews can't host a text field, so
// tapping it opens the same floating sheet (SparkCaptureActivity) as the
// tile and the accessibility button — the real form, not a copy of it.
// ---------------------------------------------------------------------------
class SparkWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        val pendingIntent = PendingIntent.getActivity(
            context,
            0,
            context.captureIntent(),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        for (widgetId in appWidgetIds) {
            val views = RemoteViews(context.packageName, R.layout.spark_widget)
            views.setOnClickPendingIntent(R.id.spark_widget_root, pendingIntent)
            appWidgetManager.updateAppWidget(widgetId, views)
        }
    }
}
