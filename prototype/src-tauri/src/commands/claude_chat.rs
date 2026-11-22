#[cfg(windows)]
mod platform;

#[tauri::command]
pub async fn open_claude_chat() -> Result<(), String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(|| platform::open(true)).await.map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    Err("Claude Chat доступен в Windows.".into())
}

#[tauri::command]
pub async fn prepare_claude_chat(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || platform::prepare(enabled)).await.map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    { let _ = enabled; Ok(()) }
}

#[tauri::command]
pub async fn start_claude_chat_dictation(run_id: String) -> Result<(), String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || platform::start(&run_id)).await.map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    { let _ = run_id; Err("Claude Chat доступен в Windows.".into()) }
}

#[tauri::command]
pub async fn stop_claude_chat_dictation(run_id: String, after_stop_ms: Option<u64>, first_word_wait_ms: Option<u64>) -> Result<String, String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || platform::stop(&run_id,
        std::time::Duration::from_millis(after_stop_ms.unwrap_or(0)),
        std::time::Duration::from_millis(first_word_wait_ms.unwrap_or(1500))))
        .await.map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    { let _ = (run_id, after_stop_ms, first_word_wait_ms); Err("Claude Chat доступен в Windows.".into()) }
}

#[tauri::command]
pub async fn poll_claude_chat_dictation(run_id: String, live: Option<bool>, known: Option<String>) -> Result<ClaudeChatPoll, String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || platform::finished(&run_id, live.unwrap_or(false), known.as_deref()))
        .await.map_err(|e| e.to_string())?
        .map(|poll| ClaudeChatPoll { finished: poll.finished, text: poll.text });
    #[cfg(not(windows))]
    { let _ = (run_id, live, known); Ok(ClaudeChatPoll { finished: false, text: None }) }
}

#[derive(serde::Serialize)]
pub struct ClaudeChatPoll { finished: bool, text: Option<String> }

#[tauri::command]
pub async fn cancel_claude_chat(run_id: Option<String>) -> Result<(), String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || platform::cancel(run_id.as_deref())).await.map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    { let _ = run_id; Ok(()) }
}

#[tauri::command]
pub fn claude_chat_running() -> Result<bool, String> {
    #[cfg(windows)]
    return platform::running();
    #[cfg(not(windows))]
    Ok(false)
}
