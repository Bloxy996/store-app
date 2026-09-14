package com.bloxy996.storesparks

import android.accessibilityservice.AccessibilityButtonController
import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.net.Uri
import android.view.accessibility.AccessibilityEvent

// ---------------------------------------------------------------------------
// This IS the "floating bubble on the screen, like the accessibility
// widget" — literally: it uses Android's own Accessibility Button system
// rather than a hand-drawn WindowManager overlay. Turn it on in Settings →
// Accessibility → Store Sparks, and the OS itself draws a floating/
// nav-bar button system-wide; tap it and onClicked() below runs.
//
// This is genuinely lighter than a self-managed overlay would be: no
// SYSTEM_ALERT_WINDOW permission, no foreground service, no persistent
// notification, no touch/drag handling to get right — the system owns
// all of that. The trade-off is less control over exactly how the button
// looks/behaves, which varies a bit by Android version and OEM (see
// android/README.md).
//
// canRetrieveWindowContent is false in accessibility_service_config.xml —
// this service never reads screen content, only listens for the button.
// onAccessibilityEvent is intentionally empty; AccessibilityService still
// requires overriding it.
// ---------------------------------------------------------------------------
class SparkAccessibilityService : AccessibilityService() {

    private var buttonCallback: AccessibilityButtonController.AccessibilityButtonCallback? = null

    override fun onServiceConnected() {
        super.onServiceConnected()
        val controller = accessibilityButtonController
        val callback = object : AccessibilityButtonController.AccessibilityButtonCallback() {
            override fun onClicked(controller: AccessibilityButtonController) {
                openCaptureForm()
            }
        }
        controller.registerAccessibilityButtonCallback(callback)
        buttonCallback = callback
    }

    override fun onUnbind(intent: Intent?): Boolean {
        buttonCallback?.let { accessibilityButtonController.unregisterAccessibilityButtonCallback(it) }
        buttonCallback = null
        return super.onUnbind(intent)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // No-op on purpose — see file header.
    }

    override fun onInterrupt() {
        // No-op — nothing to tear down beyond what onUnbind already handles.
    }

    private fun openCaptureForm() {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(SPARK_CAPTURE_URL))
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        startActivity(intent)
    }
}
