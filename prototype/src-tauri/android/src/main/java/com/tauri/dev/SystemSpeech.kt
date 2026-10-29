package com.tauri.dev

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Base64
import java.io.File
import java.util.Locale
import org.json.JSONObject
import org.json.JSONArray

object SystemSpeech {
    private val handler = Handler(Looper.getMainLooper())
    private val cancellations = mutableMapOf<String, () -> Unit>()

    fun cancel(id: String) { handler.post { cancellations[id]?.invoke() } }

    fun capabilities(context: Context, reply: (JSONObject?, String?) -> Unit) {
        handler.post {
            var engine: TextToSpeech? = null
            var finished = false
            val complete: (JSONObject?, String?) -> Unit = { data, error ->
                if (!finished) { finished = true; engine?.shutdown(); reply(data, error) }
            }
            engine = TextToSpeech(context.applicationContext) { status -> handler.post {
                val tts = engine
                if (!finished && tts != null) {
                    try {
                        if (status != TextToSpeech.SUCCESS) complete(null, "Системный движок озвучки недоступен.")
                        else {
                            val voices = JSONArray()
                            (tts.voices ?: emptySet()).filter { !it.features.contains("notInstalled") }
                                .sortedWith(compareBy({ it.locale.toLanguageTag() }, { it.name })).forEach { voice ->
                                    voices.put(JSONObject().put("id", voice.name).put("name", voice.name)
                                        .put("language", voice.locale.toLanguageTag()).put("networkRequired", voice.isNetworkConnectionRequired))
                                }
                            complete(JSONObject().put("voices", voices).put("defaultVoiceId", tts.defaultVoice?.name ?: ""), null)
                        }
                    } catch (error: Exception) { complete(null, error.message ?: "Не удалось получить голоса.") }
                }
            } }
            handler.postDelayed({ complete(null, "Не удалось получить системные голоса вовремя.") }, 15_000)
        }
    }

    fun synthesize(context: Context, text: String, id: String, options: JSONObject = JSONObject(), reply: (String?, String?) -> Unit) {
        handler.post {
            if (text.isBlank()) { reply(null, "Нет текста для озвучки."); return@post }
            if (text.length > TextToSpeech.getMaxSpeechInputLength()) {
                reply(null, "Текст превышает ограничение системного движка озвучки."); return@post
            }
            val file = File.createTempFile("speech-", ".wav", context.cacheDir)
            var engine: TextToSpeech? = null
            var finished = false
            val complete: (String?, String?) -> Unit = { data, error ->
                handler.post {
                    if (!finished) {
                        finished = true
                        cancellations.remove(id)
                        engine?.stop()
                        engine?.shutdown()
                        file.delete()
                        reply(data, error)
                    }
                }
            }
            cancellations[id] = { complete(null, "Озвучка отменена.") }
            engine = TextToSpeech(context.applicationContext) { status ->
                handler.post {
                    val tts = engine
                    if (!finished && tts != null) {
                        if (status != TextToSpeech.SUCCESS) complete(null, "Системный движок озвучки недоступен.")
                        else {
                            val languageTag = options.optString("language", "")
                            val voiceId = options.optString("voiceId", "")
                            val rate = options.optDouble("rate", 1.0).toFloat()
                            val pitch = options.optDouble("pitch", 1.0).toFloat()
                            if (!rate.isFinite() || rate !in 0.5f..2f || !pitch.isFinite() || pitch !in 0.5f..2f) {
                                complete(null, "Скорость и высота голоса должны быть от 0,5 до 2."); return@post
                            }
                            val language = tts.setLanguage(if (languageTag.isEmpty()) Locale.getDefault() else Locale.forLanguageTag(languageTag))
                            if (language == TextToSpeech.LANG_MISSING_DATA || language == TextToSpeech.LANG_NOT_SUPPORTED) {
                                complete(null, "Для системного языка не установлен голос озвучки.")
                            } else {
                                if (voiceId.isNotEmpty()) {
                                    val selected = tts.voices?.firstOrNull { it.name == voiceId }
                                    if (selected == null || tts.setVoice(selected) == TextToSpeech.ERROR) {
                                        complete(null, "Выбранный голос недоступен."); return@post
                                    }
                                }
                                if (tts.setSpeechRate(rate) == TextToSpeech.ERROR || tts.setPitch(pitch) == TextToSpeech.ERROR) {
                                    complete(null, "Движок не принял скорость или высоту голоса."); return@post
                                }
                                tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                                    override fun onStart(utteranceId: String?) {}
                                    override fun onDone(utteranceId: String?) {
                                        try { complete(Base64.encodeToString(file.readBytes(), Base64.NO_WRAP), null) }
                                        catch (error: Exception) { complete(null, error.message ?: "Не удалось прочитать озвучку.") }
                                    }
                                    @Deprecated("Legacy Android callback")
                                    override fun onError(utteranceId: String?) { complete(null, "Ошибка системной озвучки.") }
                                    override fun onError(utteranceId: String?, errorCode: Int) { complete(null, "Ошибка системной озвучки: $errorCode") }
                                })
                                if (tts.synthesizeToFile(text, null, file, id) == TextToSpeech.ERROR) complete(null, "Не удалось запустить озвучку.")
                            }
                        }
                    }
                }
            }
            handler.postDelayed({ if (!finished) complete(null, "Системный движок не завершил озвучку вовремя.") }, 120_000)
        }
    }
}
