package com.tauri.dev

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioRecordingConfiguration
import android.media.MediaRecorder
import android.util.Base64
import android.os.Build
import androidx.core.content.ContextCompat
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.sqrt

class NativeRecorder {
    @Volatile private var running = false
    @Volatile var paused = false
    @Volatile var level = 0.0
    @Volatile var silenced = false
    private var recordingCallback: AudioManager.AudioRecordingCallback? = null
    private var audio: AudioRecord? = null
    private var worker: Thread? = null
    private val samples = ByteArrayOutputStream()
    private val lock = Any()
    fun isRunning() = running

    @Synchronized
    fun start(context: Context, deviceId: String) {
        check(!running) { "Запись уже выполняется" }
        val size = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT).coerceAtLeast(4096)
        val recorder = AudioRecord.Builder()
            .setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
            .setAudioFormat(AudioFormat.Builder().setSampleRate(16000).setChannelMask(AudioFormat.CHANNEL_IN_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
            .setBufferSizeInBytes(size).build()
        try {
            check(recorder.state == AudioRecord.STATE_INITIALIZED) { "Не удалось открыть микрофон" }
            if (deviceId.isNotEmpty()) {
                val device = context.getSystemService(AudioManager::class.java).getDevices(AudioManager.GET_DEVICES_INPUTS).find { it.id.toString() == deviceId }
                    ?: throw IllegalStateException("Выбранный микрофон не найден")
                check(recorder.setPreferredDevice(device)) { "Не удалось выбрать микрофон" }
            }
            synchronized(lock) { samples.reset() }
            paused = false
            recorder.startRecording()
            check(recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) { "Нет доступа к микрофону" }
            audio = recorder
            silenced = false
            if (Build.VERSION.SDK_INT >= 29) {
                recordingCallback = object : AudioManager.AudioRecordingCallback() {
                    override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
                        silenced = configs.any { it.isClientSilenced }
                    }
                }
                recorder.registerAudioRecordingCallback(ContextCompat.getMainExecutor(context.applicationContext), recordingCallback!!)
            }
            running = true
            worker = Thread {
                val buffer = ShortArray(size / 2)
                while (running) {
                    val count = recorder.read(buffer, 0, buffer.size)
                    if (count <= 0) {
                        if (running) RuntimeBridge.dispatch("native-error", "Микрофон перестал передавать звук")
                        break
                    }
                    if (paused) { level = 0.0; continue }
                    val bytes = ByteBuffer.allocate(count * 2).order(ByteOrder.LITTLE_ENDIAN)
                    var sum = 0.0
                    for (i in 0 until count) { bytes.putShort(buffer[i]); val value = buffer[i] / 32768.0; sum += value * value }
                    level = sqrt(sum / count)
                    synchronized(lock) { if (running && !paused) samples.write(bytes.array()) }
                }
            }.also { it.name = "android-microphone"; it.start() }
        } catch (error: Exception) { recorder.release(); throw error }
    }

    @Synchronized
    private fun close() {
        running = false
        try { audio?.stop() } catch (_: Exception) {}
        worker?.join(1500)
        if (Build.VERSION.SDK_INT >= 29) recordingCallback?.let { audio?.unregisterAudioRecordingCallback(it) }
        recordingCallback = null
        audio?.release()
        audio = null
        worker = null
        level = 0.0
        silenced = false
    }

    fun snapshot(): String = synchronized(lock) {
        val data = samples.toByteArray()
        val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        header.put("RIFF".toByteArray()).putInt(data.size + 36).put("WAVEfmt ".toByteArray()).putInt(16)
        header.putShort(1).putShort(1).putInt(16000).putInt(32000).putShort(2).putShort(16)
        header.put("data".toByteArray()).putInt(data.size)
        Base64.encodeToString(header.array() + data, Base64.NO_WRAP)
    }
    fun stop(): String { close(); return snapshot() }
    fun cancel() { close(); synchronized(lock) { samples.reset() } }
}
