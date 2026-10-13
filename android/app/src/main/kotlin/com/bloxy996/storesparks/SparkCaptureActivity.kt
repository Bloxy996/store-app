package com.bloxy996.storesparks

import android.app.Activity
import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.browser.customtabs.CustomTabsIntent

// ---------------------------------------------------------------------------
// The floating "add spark" sheet. Invisible itself: it opens the PWA's
// capture form (SPARK_CAPTURE_URL) as a *partial Custom Tab* — a Chrome
// bottom sheet drawn over whatever app you're in. A Custom Tab shares
// Chrome's cookies and storage, so it's already signed in with your vault
// chosen, and it's the real form (a WebView couldn't sign in: Google blocks
// OAuth in embedded WebViews). Browsers without partial-tab support show
// the same page full-screen instead (min. height is 50%; Chrome 107+).
//
// The page talks back through storesparks:// links (declared in the
// manifest, this activity is singleTask so they land in onNewIntent):
//   storesparks://done  -> close the sheet
//   storesparks://open  -> open the full PWA, close the sheet
// Closing the tab with its own X/back lands in onResume, which also closes
// this (otherwise-blank) activity.
// ---------------------------------------------------------------------------
class SparkCaptureActivity : Activity() {

    private var tabLaunched = false
    private var tabPaused = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        route(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        route(intent)
    }

    override fun onPause() {
        super.onPause()
        if (tabLaunched) tabPaused = true
    }

    override fun onResume() {
        super.onResume()
        if (tabLaunched && tabPaused) finish()
    }

    private fun route(intent: Intent) {
        when (intent.data?.host) {
            "done" -> finish()
            "open" -> {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(SPARK_APP_URL)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                finish()
            }
            else -> launchSheet()
        }
    }

    private fun launchSheet() {
        val openApp = PendingIntent.getActivity(
            this,
            1,
            Intent(this, SparkCaptureActivity::class.java).setData(Uri.parse("storesparks://open")),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val tab = CustomTabsIntent.Builder()
            .setInitialActivityHeightPx((resources.displayMetrics.heightPixels * 0.65).toInt(), CustomTabsIntent.ACTIVITY_HEIGHT_ADJUSTABLE)
            .setToolbarCornerRadiusDp(16)
            .setShareState(CustomTabsIntent.SHARE_STATE_OFF)
            .setUrlBarHidingEnabled(true)
            .addMenuItem(getString(R.string.open_full_app), openApp)
            .build()
        tabPaused = false
        tabLaunched = true
        // Chrome only honours the partial height when the tab is started with
        // startActivityForResult (or a bound session); launchUrl() would open
        // it full-screen. Results are unused — closing is handled in onResume.
        @Suppress("DEPRECATION")
        startActivityForResult(tab.intent.setData(Uri.parse(SPARK_CAPTURE_URL)), 0)
    }
}
