use crate::app_state::{ControlHotkeyState, PasteTargetState, RecordHotkeyState, ScenarioHotkeyState};
use crate::audio_capture;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalRect, PhysicalSize};

mod audio;
mod claude_code;
pub use claude_code::{open_claude_code, cancel_claude_code, claude_code_running, start_claude_dictation, stop_claude_dictation, poll_claude_dictation, prepare_claude_code};
mod clipboard;
mod scenario_output;
mod selection;
pub use selection::get_selected_text;
pub use scenario_output::{begin_scenario_output, cancel_scenario_output, finish_scenario_output};
mod recording_file;
pub use recording_file::save_recording_file;
#[cfg(windows)]
mod clipboard_history;
mod hotkeys;
mod logs;
mod speech;
mod piper;
mod edge_speech;
pub use edge_speech::{edge_speech_voices, edge_speech_stream, edge_speech_prepare, cancel_edge_speech};
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
