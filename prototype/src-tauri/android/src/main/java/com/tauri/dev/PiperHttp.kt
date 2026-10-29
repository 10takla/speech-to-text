package com.tauri.dev

import android.util.Base64
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI

object PiperHttp {
    fun request(baseUrl: String, route: String, body: String, reply: (JSONObject?, String?) -> Unit) {
        Thread {
            try {
                val uri = URI(baseUrl)
                require(uri.scheme in listOf("http", "https") && uri.host != null && uri.userInfo == null && uri.query == null && uri.fragment == null) {
                    "Адрес Piper должен быть HTTP(S), без пароля и параметров."
                }
                require(route in listOf("voices", "info", "all-voices", "download", "synthesize")) { "Некорректный запрос Piper." }
                require((route in listOf("download", "synthesize")) == body.isNotEmpty()) { "Некорректный метод Piper." }
                val connection = URI("${baseUrl.trimEnd('/')}/$route").toURL().openConnection() as HttpURLConnection
                try {
                    connection.connectTimeout = 10000
                    connection.readTimeout = if (route == "download") 180000 else 120000
                    connection.instanceFollowRedirects = false
                    if (body.isNotEmpty()) {
                        connection.requestMethod = "POST"
                        connection.doOutput = true
                        connection.setRequestProperty("Content-Type", "application/json")
                        connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                    }
                    val status = connection.responseCode
                    val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                    val bytes = stream?.use { it.readBytes() } ?: byteArrayOf()
                    reply(JSONObject().put("status", status).put("data", Base64.encodeToString(bytes, Base64.NO_WRAP)), null)
                } finally { connection.disconnect() }
            } catch (error: Exception) { reply(null, "Piper недоступен: ${error.message}") }
        }.start()
    }
}
