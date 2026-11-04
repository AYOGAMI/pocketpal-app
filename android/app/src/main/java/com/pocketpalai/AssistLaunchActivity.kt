package com.pocketpal

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle

// Invisible hop: opens PocketPal straight into hands-free voice, then disappears.
class AssistLaunchActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("pocketpal-assist://start?ts=" + System.currentTimeMillis()))
        intent.setClass(this, MainActivity::class.java)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        startActivity(intent)
        finish()
    }
}
