use crate::app_state::{ControlHotkeyState, PasteTargetState, RecordHotkeyState, ScenarioHotkeyState};
use crate::audio_capture;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalRect, PhysicalSize};

mod audio;
mod clipboard;
mod recording_file;
pub use recording_file::save_recording_file;
#[cfg(windows)]
mod clipboard_history;
mod hotkeys;
mod logs;
mod speech;
mod piper;
pub use piper::piper_http;
pub use speech::{synthesize_system_speech, system_speech_capabilities};
mod window;
pub(crate) mod overlay_interaction;
pub use overlay_interaction::set_overlay_pinned;

pub use audio::{cancel_audio_recording, list_microphones, check_microphone, get_audio_input_level, pause_audio_recording, resume_audio_recording, snapshot_audio_recording, start_audio_recording, stop_audio_recording};
pub use clipboard::{copy_text_to_clipboard, paste_text_into_active_window, write_clipboard_text};
pub use hotkeys::{set_control_hotkeys_active, set_control_hotkeys, set_record_hotkey, set_scenario_hotkeys};
pub use logs::get_app_logs;
pub use window::{hide_overlay, is_overlay_dragging, open_microphone_settings, position_overlay_on_cursor_monitor, remember_overlay_position, resize_control_panel_to_content, resize_overlay_to_content, show_overlay, start_overlay_dragging};
