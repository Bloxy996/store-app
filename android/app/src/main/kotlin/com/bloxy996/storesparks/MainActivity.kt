package com.bloxy996.storesparks

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

// Launcher screen: gives the app a normal icon (some launchers hide widgets
// of apps that have none) and a place for the one-time setup taps. Plain
// views on purpose — no AppCompat/Material dependency for three buttons.
class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = (24 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        root.addView(TextView(this).apply {
            text = getString(R.string.main_intro)
            textSize = 16f
            setPadding(0, 0, 0, pad)
        })
        fun button(label: Int, action: () -> Unit) = root.addView(Button(this).apply {
            setText(label)
            setOnClickListener { action() }
        })
        button(R.string.main_add_now) { startActivity(captureIntent()) }
        button(R.string.main_accessibility) { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
        button(R.string.main_open_app) { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(SPARK_APP_URL))) }
        setContentView(root)
    }
}
