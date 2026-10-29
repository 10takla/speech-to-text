//! Microsoft Edge "Read aloud" neural voices: Edge's own online speech service,
//! reached directly — no browser and no key. The service is unofficial, so the
//! protocol and the Sec-MS-GEC token follow the open-source edge-tts project
//! (github.com/rany2/edge-tts); when Microsoft changes them, update the
//! constants and `drm` here. Audio is streamed to the page chunk by chunk.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio_tungstenite::tungstenite::{self, Message, client::IntoClientRequest, http::HeaderValue};

const TRUSTED_CLIENT_TOKEN: &str = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const BASE_URL: &str = "speech.platform.bing.com/consumer/speech/synthesize/readaloud";
const CHROMIUM_FULL_VERSION: &str = "143.0.3650.75";
const CHROMIUM_MAJOR_VERSION: &str = "143";
const WIN_EPOCH: i64 = 11_644_473_600;
// One SSML request is limited by the service; longer text goes in parts.
const MAX_CHUNK_BYTES: usize = 4096;
const OUTPUT_FORMAT: &str = "audio-24khz-48kbitrate-mono-mp3";
const MESSAGE_TIMEOUT: Duration = Duration::from_secs(15);

// Server time minus local time: the token is rejected when the clock is off.
static CLOCK_SKEW: AtomicI64 = AtomicI64::new(0);

// A connection opened ahead of the speech, at the scenario start: connecting takes
// about a second, so the text then goes out at once. Kept only briefly, since the
// service may close an idle connection.
const PREPARED_FOR: Duration = Duration::from_secs(30);

fn prepared() -> &'static tokio::sync::Mutex<Option<(Socket, Instant)>> {
    static PREPARED: OnceLock<tokio::sync::Mutex<Option<(Socket, Instant)>>> = OnceLock::new();
    PREPARED.get_or_init(Default::default)
}

/// Opens the connection for the next speech in advance.
#[tauri::command]
pub async fn edge_speech_prepare() -> Result<(), String> {
    // The lock is held while connecting, so a speech starting meanwhile waits for this connection.
    let mut slot = prepared().lock().await;
    if slot.as_ref().is_some_and(|(_, opened)| opened.elapsed() < PREPARED_FOR) { return Ok(()); }
    let started = Instant::now();
    let socket = connect().await?;
    log::info!("Edge TTS: соединение открыто заранее за {} мс", started.elapsed().as_millis());
    *slot = Some((socket, Instant::now()));
    Ok(())
}

async fn take_prepared() -> Option<Socket> {
    prepared().lock().await.take().filter(|(_, opened)| opened.elapsed() < PREPARED_FOR).map(|(socket, _)| socket)
}

fn cancellations() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static MAP: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    MAP.get_or_init(Default::default)
}

/// What a synthesis hands over: audio, and the time marks of words or sentences.
enum Event { Audio(Vec<u8>), Boundary(Boundary) }

/// A spoken word or sentence and when it sounds, in seconds from the start of the audio.
#[derive(serde::Serialize, Clone, Debug)]
struct Boundary { kind: String, text: String, from: f64, to: f64 }

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeVoice { id: String, name: String, language: String }

#[tauri::command]
pub async fn edge_speech_voices() -> Result<Vec<EdgeVoice>, String> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(15)).build().map_err(|error| error.to_string())?;
    for attempt in 0..2 {
        let url = format!("https://{BASE_URL}/voices/list?trustedclienttoken={TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC={}&Sec-MS-GEC-Version=2-{CHROMIUM_FULL_VERSION}", sec_ms_gec());
        let response = client.get(url)
            .header("User-Agent", user_agent())
            .header("Accept", "*/*")
            .header("Accept-Language", "en-US,en;q=0.9")
            .header("Sec-CH-UA", format!("\" Not;A Brand\";v=\"99\", \"Microsoft Edge\";v=\"{CHROMIUM_MAJOR_VERSION}\", \"Chromium\";v=\"{CHROMIUM_MAJOR_VERSION}\""))
            .header("Sec-CH-UA-Mobile", "?0")
            .header("Sec-Fetch-Site", "none").header("Sec-Fetch-Mode", "cors").header("Sec-Fetch-Dest", "empty")
            .header("Cookie", format!("muid={};", muid()))
            .send().await.map_err(|error| format!("Edge TTS: список голосов недоступен: {error}"))?;
        let status = response.status();
        if status.as_u16() == 403 && attempt == 0 && adjust_clock(response.headers().get("Date").and_then(|value| value.to_str().ok())) { continue; }
        if !status.is_success() { return Err(format!("Edge TTS: список голосов вернул HTTP {status}.")); }
        let body = response.text().await.map_err(|error| error.to_string())?;
        let list: Vec<serde_json::Value> = serde_json::from_str(&body).map_err(|_| "Edge TTS вернул неожиданный список голосов.".to_string())?;
        return Ok(list.iter().filter_map(|voice| {
            let id = voice.get("ShortName")?.as_str()?;
            let language = voice.get("Locale")?.as_str()?;
            let base = id.strip_prefix(&format!("{language}-")).unwrap_or(id).trim_end_matches("Neural");
            let base = base.replace("Multilingual", " Multilingual");
            let gender = match voice.get("Gender").and_then(|value| value.as_str()) { Some("Female") => " · жен.", Some("Male") => " · муж.", _ => "" };
            Some(EdgeVoice { id: id.into(), name: format!("{}{gender}", base.trim()), language: language.into() })
        }).collect());
    }
    Err("Edge TTS отклонил запрос: проверьте системное время.".into())
}

#[tauri::command]
pub fn cancel_edge_speech(request_id: String) {
    let mut map = cancellations().lock().unwrap_or_else(|error| error.into_inner());
    map.entry(request_id).or_default().store(true, Ordering::SeqCst);
}

/// Streams MP3 audio of `text` to `on_audio`, then an empty message; returns when the whole text is synthesized.
#[tauri::command]
pub async fn edge_speech_stream(request_id: String, text: String, voice: String, rate: f64, pitch: f64,
    on_audio: Channel<InvokeResponseBody>) -> Result<(), String> {
    if text.trim().is_empty() { return Err("Нет текста для озвучки.".into()); }
    if voice.is_empty() || !voice.chars().all(|char| char.is_ascii_alphanumeric() || char == '-') {
        return Err("Выберите голос Edge.".into());
    }
    if !rate.is_finite() || !(0.5..=2.0).contains(&rate) || !pitch.is_finite() || !(0.5..=2.0).contains(&pitch) {
        return Err("Скорость и высота голоса должны быть от 0,5 до 2.".into());
    }
    let cancel = cancellations().lock().unwrap_or_else(|error| error.into_inner()).entry(request_id.clone()).or_default().clone();
    let result = stream(&text, &voice, rate, pitch, &cancel, &on_audio).await;
    cancellations().lock().unwrap_or_else(|error| error.into_inner()).remove(&request_id);
    result
}

async fn stream(text: &str, voice: &str, rate: f64, pitch: f64, cancel: &AtomicBool, on_audio: &Channel<InvokeResponseBody>) -> Result<(), String> {
    let started = Instant::now();
    let chunks = split_text(&escape(text), MAX_CHUNK_BYTES);
    let (mut bytes, mut first) = (0usize, None::<Duration>);
    // 48 kbps constant bitrate: the audio of the parts before this one fixes where its marks start.
    let seconds = |bytes: usize| bytes as f64 * 8.0 / 48_000.0;
    let prosody = format!("pitch='{:+}Hz' rate='{:+}%' volume='+0%'", ((pitch - 1.0) * 100.0).round() as i64, ((rate - 1.0) * 100.0).round() as i64);
    for (index, chunk) in chunks.iter().enumerate() {
        let ssml = format!("<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='{voice}'><prosody {prosody}>{chunk}</prosody></voice></speak>");
        let shift = seconds(bytes);
        let received = synthesize_chunk(&ssml, OUTPUT_FORMAT, cancel, |event| match event {
            Event::Audio(audio) => {
                if first.is_none() { first = Some(started.elapsed()); }
                bytes += audio.len();
                on_audio.send(InvokeResponseBody::Raw(audio)).map_err(|error| error.to_string())
            }
            Event::Boundary(mut boundary) => {
                boundary.from += shift; boundary.to += shift;
                let json = serde_json::to_string(&boundary).map_err(|error| error.to_string())?;
                on_audio.send(InvokeResponseBody::Json(json)).map_err(|error| error.to_string())
            }
        }).await?;
        if received == 0 { return Err(format!("Edge TTS не вернул аудио (часть {} из {}).", index + 1, chunks.len())); }
    }
    // An empty message marks the end: the command result may outrun the last chunks.
    on_audio.send(InvokeResponseBody::Raw(Vec::new())).map_err(|error| error.to_string())?;
    log::info!("Edge TTS: {voice}, {} симв., частей {}, первый звук через {} мс, всего {} КБ за {} мс",
        text.chars().count(), chunks.len(), first.unwrap_or_default().as_millis(), bytes / 1024, started.elapsed().as_millis());
    Ok(())
}

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect() -> Result<Socket, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    for attempt in 0..2 {
        let url = format!("wss://{BASE_URL}/edge/v1?TrustedClientToken={TRUSTED_CLIENT_TOKEN}&ConnectionId={}&Sec-MS-GEC={}&Sec-MS-GEC-Version=2-{CHROMIUM_FULL_VERSION}",
            uuid::Uuid::new_v4().simple(), sec_ms_gec());
        let mut request = url.into_client_request().map_err(|error| error.to_string())?;
        let headers = request.headers_mut();
        for (name, value) in [
            ("Pragma", "no-cache".to_string()), ("Cache-Control", "no-cache".to_string()),
            ("Origin", "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold".to_string()),
            ("User-Agent", user_agent()), ("Accept-Language", "en-US,en;q=0.9".to_string()),
            ("Cookie", format!("muid={};", muid())),
        ] { headers.insert(name, HeaderValue::from_str(&value).map_err(|error| error.to_string())?); }
        match tokio::time::timeout(MESSAGE_TIMEOUT, tokio_tungstenite::connect_async(request)).await {
            Err(_) => return Err("Edge TTS: сервис не отвечает.".into()),
            Ok(Ok((socket, _))) => return Ok(socket),
            Ok(Err(tungstenite::Error::Http(response))) if response.status().as_u16() == 403 && attempt == 0
                && adjust_clock(response.headers().get("Date").and_then(|value| value.to_str().ok())) => continue,
            Ok(Err(tungstenite::Error::Http(response))) => return Err(format!("Edge TTS отклонил подключение: HTTP {}.", response.status())),
            Ok(Err(error)) => return Err(format!("Edge TTS: не удалось подключиться: {error}")),
        }
    }
    Err("Edge TTS отклонил подключение: проверьте системное время.".into())
}

/// Sends one SSML request, over the prepared connection when there is one; returns the number of audio bytes received.
async fn synthesize_chunk(ssml: &str, format: &str, cancel: &AtomicBool, mut on_event: impl FnMut(Event) -> Result<(), String>) -> Result<usize, String> {
    let (socket, reused) = match take_prepared().await {
        Some(socket) => (socket, true),
        None => (connect().await?, false),
    };
    let mut received = 0;
    match request(socket, ssml, format, cancel, &mut on_event, &mut received).await {
        Ok(()) => Ok(received),
        // The service may have dropped the waiting connection: repeat over a new one.
        Err(error) if reused && received == 0 && !cancel.load(Ordering::SeqCst) => {
            log::warn!("Edge TTS: заранее открытое соединение не сработало ({error}), подключение заново");
            request(connect().await?, ssml, format, cancel, &mut on_event, &mut received).await.map(|()| received)
        }
        Err(error) => Err(error),
    }
}

async fn request(mut socket: Socket, ssml: &str, format: &str, cancel: &AtomicBool,
    on_event: &mut impl FnMut(Event) -> Result<(), String>, received: &mut usize) -> Result<(), String> {
    let timestamp = js_date(now_unix());
    let config = format!("X-Timestamp:{timestamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n\
        {{\"context\":{{\"synthesis\":{{\"audio\":{{\"metadataoptions\":{{\"sentenceBoundaryEnabled\":\"true\",\"wordBoundaryEnabled\":\"true\"}},\
        \"outputFormat\":\"{format}\"}}}}}}}}\r\n");
    // The trailing "Z" after a full date is what Edge itself sends.
    let message = format!("X-RequestId:{}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:{timestamp}Z\r\nPath:ssml\r\n\r\n{ssml}", uuid::Uuid::new_v4().simple());
    let send_error = |error: tungstenite::Error| format!("Edge TTS: ошибка отправки: {error}");
    socket.send(Message::text(config)).await.map_err(send_error)?;
    socket.send(Message::text(message)).await.map_err(send_error)?;
    loop {
        if cancel.load(Ordering::SeqCst) { let _ = socket.close(None).await; return Err("Озвучка отменена".into()); }
        let message = tokio::time::timeout(MESSAGE_TIMEOUT, socket.next()).await.map_err(|_| "Edge TTS перестал отвечать.".to_string())?;
        match message {
            None | Some(Ok(Message::Close(_))) => return Err("Edge TTS закрыл соединение до конца озвучки.".into()),
            Some(Err(error)) => return Err(format!("Edge TTS: ошибка соединения: {error}")),
            Some(Ok(Message::Text(text))) => {
                if text.as_str().contains("Path:turn.end") { break; }
                if text.as_str().contains("Path:audio.metadata") { for boundary in parse_boundaries(text.as_str()) { on_event(Event::Boundary(boundary))?; } }
            }
            Some(Ok(Message::Binary(data))) => {
                if data.len() < 2 { continue; }
                let length = u16::from_be_bytes([data[0], data[1]]) as usize;
                if data.len() < 2 + length { return Err("Edge TTS прислал повреждённый фрагмент аудио.".into()); }
                let header = String::from_utf8_lossy(&data[2..2 + length]);
                let audio = &data[2 + length..];
                if header.contains("Path:audio") && header.contains("Content-Type:audio/") && !audio.is_empty() {
                    *received += audio.len();
                    on_event(Event::Audio(audio.to_vec()))?;
                }
            }
            Some(Ok(_)) => {}
        }
    }
    let _ = socket.close(None).await;
    Ok(())
}

// "…Path:audio.metadata\r\n\r\n{"Metadata":[{"Type":"WordBoundary","Data":{"Offset":..,"Duration":..,"text":{"Text":".."}}}]}"
// Offsets and durations are in 100-nanosecond ticks.
fn parse_boundaries(message: &str) -> Vec<Boundary> {
    let Some((_, body)) = message.split_once("\r\n\r\n") else { return Vec::new() };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(body.trim()) else { return Vec::new() };
    let Some(items) = json.get("Metadata").and_then(|value| value.as_array()) else { return Vec::new() };
    items.iter().filter_map(|item| {
        let kind = item.get("Type")?.as_str()?;
        if kind != "WordBoundary" && kind != "SentenceBoundary" { return None; }
        let data = item.get("Data")?;
        let from = data.get("Offset")?.as_f64()? / 10_000_000.0;
        let to = from + data.get("Duration").and_then(|value| value.as_f64()).unwrap_or(0.0) / 10_000_000.0;
        let text = data.get("text")?.get("Text")?.as_str()?.to_string();
        Some(Boundary { kind: kind.into(), text, from, to })
    }).collect()
}

fn user_agent() -> String {
    format!("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/{CHROMIUM_MAJOR_VERSION}.0.0.0")
}

fn muid() -> String { uuid::Uuid::new_v4().simple().to_string().to_uppercase() }

fn now_unix() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_secs() as i64).unwrap_or(0) + CLOCK_SKEW.load(Ordering::Relaxed)
}

fn sec_ms_gec() -> String { gec_token(now_unix()) }

// Windows file time rounded down to 5 minutes, followed by the client token.
fn gec_token(unix: i64) -> String {
    let mut seconds = unix + WIN_EPOCH;
    seconds -= seconds.rem_euclid(300);
    drm::token(format!("{}{TRUSTED_CLIENT_TOKEN}", seconds as u64 * 10_000_000).as_bytes())
}

/// Corrects the clock from the server's `Date` header; false when it cannot.
fn adjust_clock(date: Option<&str>) -> bool {
    let Some(server) = date.and_then(parse_http_date) else { return false };
    CLOCK_SKEW.fetch_add(server - now_unix(), Ordering::Relaxed);
    log::warn!("Edge TTS: поправка часов на {} с", CLOCK_SKEW.load(Ordering::Relaxed));
    true
}

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "Thu, 29 Oct 2026 10:00:00 GMT"
fn parse_http_date(value: &str) -> Option<i64> {
    let parts: Vec<&str> = value.split_whitespace().collect();
    let [_, day, month, year, time, ..] = parts.as_slice() else { return None };
    let month = MONTHS.iter().position(|name| name == month)? as i64 + 1;
    let mut clock = time.split(':').map(|part| part.parse::<i64>().ok());
    let (hour, minute, second) = (clock.next()??, clock.next()??, clock.next()??);
    Some(days_from_civil(year.parse().ok()?, month, day.parse().ok()?) * 86_400 + hour * 3600 + minute * 60 + second)
}

// "Thu Oct 29 2026 10:00:00 GMT+0000 (Coordinated Universal Time)", as JavaScript prints dates.
fn js_date(unix: i64) -> String {
    const DAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    let (days, seconds) = (unix.div_euclid(86_400), unix.rem_euclid(86_400));
    let (year, month, day) = civil_from_days(days);
    format!("{} {} {day:02} {year} {:02}:{:02}:{:02} GMT+0000 (Coordinated Universal Time)",
        DAYS[days.rem_euclid(7) as usize], MONTHS[month as usize - 1], seconds / 3600, seconds / 60 % 60, seconds % 60)
}

// Howard Hinnant's civil calendar algorithms.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    era * 146_097 + (year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year) - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted + 2) / 5 + 1;
    let month = if shifted < 10 { shifted + 3 } else { shifted - 9 };
    (year_of_era + era * 400 + i64::from(month <= 2), month, day)
}

// The service rejects control characters (vertical tabs from OCR-ed PDFs, for one).
fn escape(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for char in text.chars() {
        match char {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '\u{0}'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' => escaped.push(' '),
            _ => escaped.push(char),
        }
    }
    escaped
}

/// Splits escaped text at a newline or space, never inside a character or an XML entity.
fn split_text(text: &str, limit: usize) -> Vec<String> {
    let mut parts = Vec::new();
    let mut rest = text.trim();
    while rest.len() > limit {
        let mut end = limit;
        while !rest.is_char_boundary(end) { end -= 1; }
        let mut at = rest[..end].rfind(['\n', ' ']).filter(|&at| at > 0).unwrap_or(end);
        if let Some(amp) = rest[..at].rfind('&') && !rest[amp..at].contains(';') && amp > 0 { at = amp; }
        let part = rest[..at].trim();
        if !part.is_empty() { parts.push(part.to_string()); }
        rest = rest[at..].trim_start();
    }
    if !rest.is_empty() { parts.push(rest.to_string()); }
    parts
}

/// Sec-MS-GEC v2: "<CS64 hex>-<SHA-256 hex>" of the time-based string. The
/// SHA-256 starts from a state precomputed over a 57-byte secret prefix and
/// the first 7 bytes of the data; ported from edge-tts drm.py.
mod drm {
    const INITIAL: [u32; 8] = [0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19];
    const STATE: [u32; 8] = [0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A, 0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2];
    const SCHEDULE: [u32; 14] = [0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA, 0xA622EE8C, 0xD1DD9491, 0xC0DD25A0,
        0xF9E70AB6, 0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33, 0xD258B060, 0x72766564];
    const K: [u32; 64] = [
        0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
        0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
        0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
        0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
        0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
        0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
        0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
        0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2,
    ];
    const ADJUSTMENT: u32 = 0xC9DC06A7;
    const SIGMA0_ADJUSTMENT: u32 = 0x059C0B80;
    const SIGMA1_ADJUSTMENT: u32 = 0x000B92C0;
    const CS64_COEFFICIENTS: [(u32, u32); 14] = [
        (0xE82E91B1, 0xB32700D0), (0x44DE24C6, 0x88DFF51D), (0x3BEB65BC, 0x29514038), (0xC89C5933, 0xB328CBDF),
        (0x8D1EC211, 0xD405B4D5), (0x314EF5D5, 0x26E55F3C), (0xE92491B1, 0x607801C6), (0xF0A5B9D5, 0x82B2C1FB),
        (0x06064CF3, 0xFA51A3DA), (0xDA79FA60, 0x207CC464), (0xBED20560, 0x3C3C74F3), (0x89F9C9F8, 0xD2D14B61),
        (0x35FA38C6, 0xBB04A2C1), (0xCB49E3C6, 0xC5626167),
    ];
    const CS64_FACTOR: u32 = 0x82893933;
    const CS64_ADJUSTMENT0: u32 = 0xF2F90B1A;
    const CS64_ADJUSTMENT1: u32 = 0x0B1A0000;

    fn sigma0(value: u32) -> u32 { value.rotate_right(7) ^ value.rotate_right(18) ^ (value >> 3) }
    fn sigma1(value: u32) -> u32 { value.rotate_right(17) ^ value.rotate_right(19) ^ (value >> 10) }
    fn rol16(value: u32) -> u32 { value.rotate_left(16) }

    fn expand(words: &mut [u32; 64], first: usize) {
        for index in first..64 {
            words[index] = sigma1(words[index - 2]).wrapping_add(words[index - 7]).wrapping_add(sigma0(words[index - 15])).wrapping_add(words[index - 16]);
        }
    }

    // Standard SHA-256 rounds, optionally resumed at round 14 of the first block.
    fn rounds(state: [u32; 8], words: &[u32; 64], first: usize) -> [u32; 8] {
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
        for index in first..64 {
            let constant = if first == 14 && index == 14 { ADJUSTMENT } else { K[index] };
            let t1 = h.wrapping_add(e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25))
                .wrapping_add(g ^ (e & (f ^ g))).wrapping_add(constant).wrapping_add(words[index]);
            let t2 = (a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22)).wrapping_add((a & b) | (c & (a | b)));
            (h, g, f, e, d, c, b, a) = (g, f, e, d.wrapping_add(t1), c, b, a, t1.wrapping_add(t2));
        }
        [a, b, c, d, e, f, g, h]
    }

    fn add(left: [u32; 8], right: [u32; 8]) -> [u32; 8] { std::array::from_fn(|index| left[index].wrapping_add(right[index])) }

    fn init(data: &[u8]) -> [u32; 8] {
        let mut words = [0u32; 64];
        words[14] = u32::from_be_bytes([0, data[0], data[1], data[2]]);
        words[15] = u32::from_be_bytes([data[3], data[4], data[5], data[6]]);
        for index in 16..30 {
            let mut value = SCHEDULE[index - 16];
            if index - 2 >= 14 {
                let sigma = sigma1(words[index - 2]);
                value = value.wrapping_add(if index == 16 { sigma ^ SIGMA1_ADJUSTMENT } else { sigma });
            }
            if index - 7 >= 14 { value = value.wrapping_add(words[index - 7]); }
            if index - 15 >= 14 {
                let sigma = sigma0(words[index - 15]);
                value = value.wrapping_add(if index == 29 { sigma ^ SIGMA0_ADJUSTMENT } else { sigma });
            }
            words[index] = value;
        }
        words[30] = sigma1(words[28]).wrapping_add(words[23]).wrapping_add(sigma0(words[15])).wrapping_add(words[14])
            .wrapping_add(ADJUSTMENT).wrapping_sub(K[14]);
        expand(&mut words, 31);
        add(INITIAL, rounds(STATE, &words, 14))
    }

    pub(super) fn sha256(data: &[u8]) -> [u8; 32] {
        let length = 57 + data.len();
        let mut padded = data[7..].to_vec();
        padded.push(0x80);
        padded.resize(padded.len() + (55 - length as i64).rem_euclid(64) as usize, 0);
        padded.extend_from_slice(&((length * 8) as u64).to_be_bytes());
        let mut state = init(&data[..7]);
        for block in padded.chunks(64) {
            let mut words = [0u32; 64];
            for (index, word) in block.chunks(4).enumerate() { words[index] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]); }
            expand(&mut words, 16);
            state = add(state, rounds(state, &words, 0));
        }
        let mut digest = [0u8; 32];
        for (index, word) in state.iter().enumerate() { digest[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes()); }
        digest
    }

    // Little-endian 32-bit words, zero-padded to an even count.
    fn words_le(data: &[u8]) -> Vec<u32> {
        let mut padded = data.to_vec();
        padded.resize(padded.len().div_ceil(4) * 4, 0);
        let mut words: Vec<u32> = padded.chunks(4).map(|word| u32::from_le_bytes([word[0], word[1], word[2], word[3]])).collect();
        if words.len() % 2 == 1 { words.push(0); }
        words
    }

    pub(super) fn cs64(data: &[u8], digest: &[u8; 32]) -> (u32, u32) {
        let key_a = u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]]) | 1;
        let key_b = u32::from_le_bytes([digest[4], digest[5], digest[6], digest[7]]) | 1;
        let factors = [key_a.wrapping_mul(CS64_FACTOR), key_b.wrapping_mul(CS64_FACTOR)];
        let mut terms: Vec<u32> = CS64_COEFFICIENTS.iter().enumerate().map(|(index, (coefficient, _))| coefficient.wrapping_mul(factors[index % 2])).collect();
        let mut offsets: Vec<u32> = CS64_COEFFICIENTS.iter().map(|(_, offset)| *offset).collect();
        let mut input = vec![0u8];
        input.extend_from_slice(data);
        for (index, word) in words_le(&input).into_iter().enumerate() {
            let even = index % 2 == 0;
            let mut term = word.wrapping_mul(if even { key_a } else { key_b });
            let mut offset = rol16(word).wrapping_mul(if even { 0xEF0569FB } else { 0xC31713DB });
            if index == 0 {
                term = term.wrapping_add(CS64_ADJUSTMENT0.wrapping_mul(factors[0]));
                offset = offset.wrapping_add(CS64_ADJUSTMENT1);
            }
            terms.push(term);
            offsets.push(offset);
        }
        let (mut swap_acc, mut swap_last, mut state, mut acc) = (0u32, 0u32, 0u32, 0u32);
        for index in (0..terms.len()).step_by(2) {
            let (x, y) = (terms[index], terms[index + 1]);
            let q = rol16(offsets[index].wrapping_add(x)).wrapping_mul(0x76F50F34);
            swap_acc = swap_acc.wrapping_add(rol16(q).wrapping_mul(0xC3EFEA97).wrapping_add(q));
            let q = rol16(offsets[index + 1].wrapping_add(y)).wrapping_mul(0x1881CE3C);
            swap_last = rol16(q).wrapping_mul(0x35BD1EC9).wrapping_add(q);
            swap_acc = swap_acc.wrapping_add(swap_last);

            state = state.wrapping_mul(key_a).wrapping_add(x);
            state = rol16(state).wrapping_mul(0xCF98B111);
            state = rol16(state).wrapping_mul(0x87085B9F);
            state = rol16(state).wrapping_mul(0x12CEB96D);
            state = rol16(state).wrapping_mul(0x257E1D83);
            acc = acc.wrapping_add(state);
            let mut t = state.wrapping_mul(key_b).wrapping_add(y);
            t = rol16(t).wrapping_mul(0xA27416F5);
            t = rol16(t).wrapping_mul(0xD38396FF);
            state = rol16(rol16(t).wrapping_mul(0x7C932B89)).wrapping_mul(0xBFA49F69);
            acc = acc.wrapping_add(state);
        }
        (swap_last ^ state, swap_acc ^ acc)
    }

    pub(super) fn token(data: &[u8]) -> String {
        let digest = sha256(data);
        let (low, high) = cs64(data, &digest);
        let hex = |bytes: &[u8]| bytes.iter().map(|byte| format!("{byte:02X}")).collect::<String>();
        format!("{}{}-{}", hex(&low.to_le_bytes()), hex(&high.to_le_bytes()), hex(&digest))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_dates_like_edge() {
        assert_eq!(js_date(0), "Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)");
        assert_eq!(js_date(1_793_268_000), "Thu Oct 29 2026 10:00:00 GMT+0000 (Coordinated Universal Time)");
        assert_eq!(parse_http_date("Thu, 29 Oct 2026 10:00:00 GMT"), Some(1_793_268_000));
    }

    #[test]
    fn token_has_v2_shape_and_changes_every_five_minutes() {
        let token = gec_token(1_793_268_000);
        assert_eq!(token.len(), 16 + 1 + 64);
        assert_eq!(token, gec_token(1_793_268_299));
        assert_ne!(token, gec_token(1_793_268_300));
    }

    #[test]
    fn splits_without_breaking_entities() {
        let parts = split_text("aaa &amp; bbb", 7);
        assert!(parts.iter().all(|part| !part.contains('&') || part.contains("&amp;")), "{parts:?}");
        assert_eq!(split_text("привет мир", 13), vec!["привет", "мир"]);
        assert_eq!(escape("a<b>&\u{b}"), "a&lt;b&gt;&amp; ");
    }

    #[test]
    fn parses_boundaries() {
        let message = "X-RequestId:1\r\nContent-Type:application/json; charset=utf-8\r\nPath:audio.metadata\r\n\r\n{\"Metadata\":[{\"Type\":\"WordBoundary\",\"Data\":{\"Offset\":1000000,\"Duration\":3500000,\"text\":{\"Text\":\"Привет\",\"Length\":6,\"BoundaryType\":\"WordBoundary\"}}},{\"Type\":\"SessionEnd\",\"Data\":{\"Offset\":9}}]}";
        let boundaries = parse_boundaries(message);
        assert_eq!(boundaries.len(), 1);
        assert_eq!(boundaries[0].text, "Привет");
        assert!((boundaries[0].from - 0.1).abs() < 1e-9 && (boundaries[0].to - 0.45).abs() < 1e-9);
    }

    // Hits the live service: cargo test edge_live -- --ignored --nocapture
    #[test]
    #[ignore]
    fn edge_live() {
        tauri::async_runtime::block_on(async {
            edge_speech_prepare().await.unwrap();
            let started = Instant::now();
            let mut first = None;
            let mut total = 0;
            let ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='ru-RU-SvetlanaNeural'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>Проверка связи.</prosody></voice></speak>";
            let received = synthesize_chunk(ssml, OUTPUT_FORMAT, &AtomicBool::new(false), |event| { if let Event::Audio(audio) = event { first.get_or_insert(started.elapsed()); total += audio.len(); } Ok(()) }).await.unwrap();
            println!("audio bytes: {received}, first audio over the prepared connection after {:?}", first.unwrap_or_default());
            assert!(take_prepared().await.is_none(), "the prepared connection is used up");
            assert!(received > 1000 && total == received);
            let voices = edge_speech_voices().await.unwrap();
            println!("voices: {}", voices.len());
            assert!(voices.iter().any(|voice| voice.id == "ru-RU-SvetlanaNeural"));
        });
    }
}
