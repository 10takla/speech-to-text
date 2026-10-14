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
    state.start(device_id)
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
    if let Ok(mut target) = paste_target.0.lock() {
        target.hwnd = None;
        target.recording = false;
    }
}
