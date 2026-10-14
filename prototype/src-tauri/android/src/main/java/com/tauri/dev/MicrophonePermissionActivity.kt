package com.tauri.dev

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.core.content.ContextCompat

class MicrophonePermissionActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            finishPermissionRequest(true)
        } else {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_MICROPHONE)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_MICROPHONE) return
        finishPermissionRequest(grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED)
    }

    private fun finishPermissionRequest(granted: Boolean) {
        RuntimeBridge.bubble?.completeMicrophonePermission(granted)
        // Remove the temporary permission task and reveal the user's original application.
        finishAndRemoveTask()
    }

    private companion object {
        const val REQUEST_MICROPHONE = 41
    }
}
