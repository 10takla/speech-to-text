package com.tauri.dev

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder

/** Keeps microphone capture alive while the user records from the input method. */
class RecordingService : Service() {
    private val channelId = "speech-recording"
    private val notificationId = 1
    private var foregroundStarted = false

    override fun onCreate() {
        super.onCreate()
        RuntimeBridge.service = this
        val notifications = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            notifications.createNotificationChannel(NotificationChannel(channelId, "Запись речи", NotificationManager.IMPORTANCE_LOW))
        }
        updateState("recording", "Идёт запись")
    }

    fun updateState(state: String, _text: String) {
        val open = PendingIntent.getActivity(this, 0, Intent(this, com.speechtotext.app.MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, channelId) else Notification.Builder(this)
        val title = when (state) {
            "recording" -> "Идёт запись речи"
            "editing" -> "Редактирование записи"
            "transcribing" -> "Распознавание речи"
            "error" -> "Ошибка голосового ввода"
            else -> "Голосовой ввод"
        }
        val notification = builder.setContentTitle(title)
            .setContentText("Управление доступно в оверлее Speech to Text")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentIntent(open)
            .setOnlyAlertOnce(true)
            .build()
        if (!foregroundStarted) {
            startForeground(notificationId, notification)
            foregroundStarted = true
        } else {
            getSystemService(NotificationManager::class.java).notify(notificationId, notification)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int) = START_NOT_STICKY
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        RuntimeBridge.recorder.cancel()
        if (RuntimeBridge.service === this) RuntimeBridge.service = null
        super.onDestroy()
    }
}
