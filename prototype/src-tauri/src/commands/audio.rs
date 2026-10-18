use super::*;

#[tauri::command]
pub fn pause_audio_recording(
    state: tauri::State<'_, audio_capture::AudioCaptureState>,
) -> Result<(), String> {
    state.pause()
}

#[tauri::command]
pub fn resume_audio_recording(
    state: tauri::State<'_, audio_capture::AudioCaptureState>,
) -> Result<(), String> {
    state.resume()
}

#[tauri::command]
pub fn start_audio_recording(
    state: tauri::State<'_, audio_capture::AudioCaptureState>,
    device_id: Option<String>,
) -> Result<(), String> {
    #[cfg(windows)]
    super::clipboard_history::begin_recording();
    let result = state.start(device_id);
    #[cfg(windows)]
    if result.is_err() {
        super::clipboard_history::end_recording();
    }
    result
}

#[tauri::command]
pub fn list_microphones() -> Result<Vec<audio_capture::Microphone>, String> {
    audio_capture::list_microphones()
}

#[tauri::command]
pub fn check_microphone(device_id: Option<String>) -> Result<(), String> {
    audio_capture::check_microphone(device_id.as_deref())
}

#[tauri::command]
pub fn get_audio_input_level(
    state: tauri::State<'_, audio_capture::AudioCaptureState>,
) -> f32 {
    state.input_level()
}

#[tauri::command]
pub fn snapshot_audio_recording(
    state: tauri::State<'_, audio_capture::AudioCaptureState>,
) -> Result<tauri::ipc::Response, String> {
    state.snapshot().map(tauri::ipc::Response::new)
}

#[tauri::command]
pub fn stop_audio_recording(
    state: tauri::State<'_, audio_capture::AudioCaptureState>,
) -> Result<tauri::ipc::Response, String> {
    state.stop().map(tauri::ipc::Response::new)
}

#[tauri::command]
pub fn cancel_audio_recording(
    state: tauri::State<'_, audio_capture::AudioCaptureState>,
    paste_target: tauri::State<'_, PasteTargetState>,
) {
    state.cancel();
    #[cfg(windows)]
    super::clipboard_history::end_recording();
    if let Ok(mut target) = paste_target.0.lock() {
        target.hwnd = None;
        target.recording = false;
    }
}
