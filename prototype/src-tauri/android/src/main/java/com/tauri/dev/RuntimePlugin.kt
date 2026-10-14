package com.tauri.dev

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioManager
import android.media.AudioDeviceInfo
import android.media.ToneGenerator
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.webkit.WebView
import androidx.core.content.ContextCompat
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject

@InvokeArg
class RuntimePayload {
    var deviceId: String = ""
    var state: String = ""
    var status: String = ""
    var text: String = ""
}

@InvokeArg
class RuntimeArgs {
    var action: String = ""
    var payload: RuntimePayload = RuntimePayload()
}

object RuntimeBridge {
    var emit: ((String, String) -> Unit)? = null
    var bubbleEmit: ((String, String) -> Unit)? = null
    fun dispatch(action: String, text: String) { (bubbleEmit ?: emit)?.invoke(action, text) }
    val recorder = NativeRecorder()
    var service: RecordingService? = null
    var bubble: SpeechBubbleService? = null
    var lastText = ""
}

@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = "microphone")])
class RuntimePlugin(private val activity: Activity) : Plugin(activity) {
    private var configurationToSave = ""
    private var runtimeWebView: WebView? = null

    @ActivityCallback
    fun configurationFileChosen(invoke: Invoke, result: ActivityResult) {
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) { invoke.resolve(); return }
        try {
            val output = activity.contentResolver.openOutputStream(uri) ?: throw IllegalStateException("Не удалось открыть файл")
            output.use { it.write(configurationToSave.toByteArray(Charsets.UTF_8)) }
            configurationToSave = ""
            invoke.resolve()
        } catch (error: Exception) { invoke.reject(error.message ?: "Ошибка сохранения") }
    }
    override fun onDestroy() {
        RuntimeBridge.emit = null
    }
    override fun load(webView: WebView) {
        runtimeWebView = webView
        RuntimeBridge.emit = { action, text ->
            val detail = JSONObject().put("action", action).put("text", text).toString()
            webView.post { webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('android-runtime-event',{detail:$detail}))", null) }
        }
    }

    @Command
    fun call(invoke: Invoke) {
        val args = invoke.parseArgs(RuntimeArgs::class.java)
        if (args.action in listOf("start", "checkMicrophone", "requestMicrophonePermission") && ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissionForAlias("microphone", invoke, "microphonePermission")
            return
        }
        execute(invoke, args)
    }

    @PermissionCallback
    fun microphonePermission(invoke: Invoke) {
        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            invoke.reject("Разрешите доступ к микрофону в настройках приложения.")
            return
        }
        execute(invoke, invoke.parseArgs(RuntimeArgs::class.java))
    }

    private fun execute(invoke: Invoke, args: RuntimeArgs) {
        try {
            when (args.action) {
                "requestMicrophonePermission" -> invoke.resolve()
                "microphones" -> {
                    val manager = activity.getSystemService(AudioManager::class.java)
                    val devices = manager.getDevices(AudioManager.GET_DEVICES_INPUTS).filter { it.type != AudioDeviceInfo.TYPE_TELEPHONY }
                    val list = mutableListOf(mapOf("id" to "", "name" to "Системный микрофон", "error" to if (devices.isEmpty()) "Микрофон не найден" else null))
                    for (device in devices) list.add(mapOf("id" to device.id.toString(), "name" to device.productName.toString(), "error" to null))
                    invoke.resolveObject(list)
                }
                "checkMicrophone" -> {
                    if (RuntimeBridge.recorder.isRunning()) throw IllegalStateException("Остановите запись перед проверкой микрофона.")
                    val probe = NativeRecorder()
                    try { probe.start(activity, args.payload.deviceId) } finally { probe.cancel() }
                    invoke.resolve()
                }
                "start" -> {
                    if (RuntimeBridge.service == null) ContextCompat.startForegroundService(activity, Intent(activity, RecordingService::class.java))
                    RuntimeBridge.recorder.start(activity, args.payload.deviceId)
                    invoke.resolve()
                }
                "pause" -> { RuntimeBridge.recorder.paused = true; invoke.resolve() }
                "resume" -> { RuntimeBridge.recorder.paused = false; invoke.resolve() }
                "snapshot" -> invoke.resolve(JSObject().put("data", RuntimeBridge.recorder.snapshot()))
                "stop" -> invoke.resolve(JSObject().put("data", RuntimeBridge.recorder.stop()))
                "cancel" -> { RuntimeBridge.recorder.cancel(); invoke.resolve() }
                "level" -> invoke.resolveObject(RuntimeBridge.recorder.level)
                "recordingStatus" -> invoke.resolve(JSObject().put("recording", RuntimeBridge.recorder.isRunning()).put("paused", RuntimeBridge.recorder.paused))
                "frontendReady" -> invoke.resolve()
                "getLogs" -> {
                    val process = Runtime.getRuntime().exec(arrayOf("logcat", "-d", "--pid=${android.os.Process.myPid()}"))
                    val logs = process.inputStream.bufferedReader().use { it.readText() }
                    check(process.waitFor() == 0) { "Не удалось прочитать системный журнал приложения." }
                    invoke.resolve(JSObject().put("logs", logs))
                }
                "saveBubbleConfiguration" -> {
                    val preferences = activity.getSharedPreferences("speech-keyboard", Activity.MODE_PRIVATE)
                    val editor = preferences.edit().putString("configuration", args.payload.text)
                    runtimeWebView?.url?.let { url ->
                        val uri = Uri.parse(url)
                        if (uri.host == "127.0.0.1" || uri.host == "tauri.localhost") {
                            editor.putString("runtimeOrigin", "${uri.scheme}://${uri.authority}")
                        }
                    }
                    editor.apply()
                    RuntimeBridge.bubble?.syncConfiguration()
                    invoke.resolve()
                }
                "setOutputText" -> { RuntimeBridge.lastText = args.payload.text; invoke.resolve() }
                "paste" -> {
                    RuntimeBridge.lastText = args.payload.text
                    val bubble = RuntimeBridge.bubble ?: throw IllegalStateException("Включите плавающий оверлей для вставки текста.")
                    bubble.paste(args.payload.text)
                    invoke.resolve()
                }
                "bubbleSettings" -> { activity.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)); invoke.resolve() }
                "playSound" -> {
                    val tone = ToneGenerator(AudioManager.STREAM_NOTIFICATION, 35)
                    tone.startTone(if (args.payload.state == "error") ToneGenerator.TONE_PROP_NACK else ToneGenerator.TONE_PROP_BEEP, 100)
                    Handler(Looper.getMainLooper()).postDelayed({ tone.release() }, 200)
                    invoke.resolve()
                }
                "updateState" -> {
                    RuntimeBridge.service?.updateState(args.payload.state, args.payload.status)
                    invoke.resolve()
                }
                "stopRecordingService" -> { activity.stopService(Intent(activity, RecordingService::class.java)); invoke.resolve() }
                "microphoneSettings" -> { activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).setData(android.net.Uri.parse("package:${activity.packageName}"))); invoke.resolve() }
                "saveConfiguration" -> {
                    configurationToSave = args.payload.text
                    val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                        .setType("application/json").putExtra(Intent.EXTRA_TITLE, "speech-to-text-config.json")
                    startActivityForResult(invoke, intent, "configurationFileChosen")
                }
                else -> invoke.reject("Неизвестная Android-команда: ${args.action}")
            }
        } catch (error: Exception) { invoke.reject(error.message ?: "Ошибка Android") }
    }
}
