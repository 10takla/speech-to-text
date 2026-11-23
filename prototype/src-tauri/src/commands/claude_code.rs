// Console transport adapted from claude-dictate (android6, MIT).
#[cfg(windows)]
mod platform;

#[tauri::command]
pub async fn open_claude_code() -> Result<(), String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(|| platform::open(true)).await.map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    Err("Диктовка Claude Code доступна в Windows.".into())
}

#[tauri::command]
pub async fn hide_claude_code() -> Result<(), String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(platform::hide).await.map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    Ok(())
}

#[tauri::command]
pub fn claude_code_visible() -> Result<bool, String> {
    #[cfg(windows)]
    return platform::visible();
    #[cfg(not(windows))]
    Ok(false)
}

#[tauri::command]
pub async fn prepare_claude_code(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || platform::prepare(enabled)).await.map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    { let _ = enabled; Ok(()) }
}

#[tauri::command]
pub async fn start_claude_dictation(run_id: String) -> Result<(), String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || platform::start(&run_id)).await.map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    { let _ = run_id; Err("Диктовка Claude Code доступна в Windows.".into()) }
}

#[tauri::command]
pub async fn stop_claude_dictation(run_id: String, after_stop_ms: Option<u64>, first_word_wait_ms: Option<u64>) -> Result<String, String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || platform::stop(&run_id,
        std::time::Duration::from_millis(after_stop_ms.unwrap_or(0)),
        std::time::Duration::from_millis(first_word_wait_ms.unwrap_or(1500))))
        .await.map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    { let _ = (run_id, after_stop_ms, first_word_wait_ms); Err("Диктовка Claude Code доступна в Windows.".into()) }
}

#[tauri::command]
pub async fn poll_claude_dictation(run_id: String, live: Option<bool>, known: Option<String>) -> Result<ClaudePoll, String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || platform::finished(&run_id, live.unwrap_or(false), known.as_deref()))
        .await.map_err(|e| e.to_string())?
        .map(|poll| ClaudePoll { finished: poll.finished, text: poll.text });
    #[cfg(not(windows))]
    { let _ = (run_id, live, known); Ok(ClaudePoll { finished: false, text: None }) }
}

// `text` is Claude's interim transcript shown in its prompt, when requested
// and recognised on screen.
#[derive(serde::Serialize)]
pub struct ClaudePoll { finished: bool, text: Option<String> }

#[tauri::command]
pub async fn cancel_claude_code(run_id: Option<String>) -> Result<(), String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || platform::cancel(run_id.as_deref())).await.map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    { let _ = run_id; Ok(()) }
}

#[tauri::command]
pub fn claude_code_running() -> Result<bool, String> {
    #[cfg(windows)]
    return platform::running();
    #[cfg(not(windows))]
    Ok(false)
}
