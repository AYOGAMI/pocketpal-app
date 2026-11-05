package com.pocketpal

import android.app.Activity
import android.content.Intent
import android.os.Bundle

// Invisible hop: opens the transparent assistant panel, then disappears.
class AssistLaunchActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val intent = Intent(this, AssistActivity::class.java)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION)
        startActivity(intent)
        finish()
        overridePendingTransition(0, 0)
    }
}
