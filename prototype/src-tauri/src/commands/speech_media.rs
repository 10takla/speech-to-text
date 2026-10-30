#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpeechPlaybackState { None, Paused, Playing }

#[derive(Default)]
pub struct SpeechMediaState {
    #[cfg(windows)]
    session: std::sync::Mutex<Option<native::Session>>,
}

#[cfg(windows)]
mod native;

#[tauri::command]
pub fn set_speech_media_state(
    window: tauri::WebviewWindow,
    controls: tauri::State<'_, SpeechMediaState>,
    state: SpeechPlaybackState,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        use tauri::Emitter;
        if window.label() != "overlay" { return Err("Speech media controls belong to the overlay.".into()); }
        let mut session = controls.session.lock().map_err(|error| error.to_string())?;
        if session.is_none() {
            if matches!(state, SpeechPlaybackState::None) { return Ok(()); }
            let hwnd = windows::Win32::Foundation::HWND(window.hwnd().map_err(|error| error.to_string())?.0);
            let target = window.clone();
            *session = Some(native::Session::new(hwnd, "Озвучка", move |action| {
                let _ = target.emit_to(target.label(), "speech-media-action", action);
            }).map_err(|error| error.to_string())?);
        }
        session.as_ref().unwrap().set_state(state).map_err(|error| error.to_string())?;
    }
    #[cfg(not(windows))]
    let _ = (window, controls, state);
    Ok(())
}
