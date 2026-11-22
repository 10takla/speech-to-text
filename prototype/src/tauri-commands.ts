import type { invoke as TauriInvoke } from '@tauri-apps/api/core';

type CommandContract = {
  set_speech_media_state: { args: { state: 'none' | 'paused' | 'playing' }; result: void };
  open_claude_code: { args: undefined; result: void };
  cancel_claude_code: { args: { runId: string } | undefined; result: void };
  start_claude_dictation: { args: { runId: string }; result: void };
  stop_claude_dictation: { args: { runId: string; afterStopMs?: number; firstWordWaitMs?: number }; result: string };
  prepare_claude_code: { args: { enabled: boolean }; result: void };
  poll_claude_dictation: { args: { runId: string; live: boolean; known: string | null }; result: { finished: boolean; text: string | null } };
  claude_code_running: { args: undefined; result: boolean };
  open_claude_chat: { args: undefined; result: void };
  prepare_claude_chat: { args: { enabled: boolean }; result: void };
  claude_chat_running: { args: undefined; result: boolean };
  start_claude_chat_dictation: { args: { runId: string }; result: void };
  stop_claude_chat_dictation: { args: { runId: string; afterStopMs?: number; firstWordWaitMs?: number }; result: string };
  poll_claude_chat_dictation: { args: { runId: string; live: boolean; known: string | null }; result: { finished: boolean; text: string | null } };
  cancel_claude_chat: { args: { runId: string } | undefined; result: void };
  open_antigravity_cli: { args: undefined; result: void };
  cancel_antigravity_cli: { args: { runId: string } | undefined; result: void };
  start_antigravity_dictation: { args: { runId: string }; result: void };
  stop_antigravity_dictation: { args: { runId: string; afterStopMs?: number; firstWordWaitMs?: number }; result: string };
  prepare_antigravity_cli: { args: { enabled: boolean }; result: void };
  poll_antigravity_dictation: { args: { runId: string; live: boolean; known: string | null }; result: { finished: boolean; text: string | null } };
  antigravity_cli_running: { args: undefined; result: boolean };
  get_selected_text: { args: { runId: string }; result: string };
  get_start_in: { args: undefined; result: '' | 'window' | 'taskbar' | 'tray' };
  set_start_in: { args: { mode: '' | 'window' | 'taskbar' | 'tray' }; result: void };
  position_overlay_on_cursor_monitor: { args: { reset?: boolean } | undefined; result: boolean };
  show_overlay: { args: undefined; result: void };
  hide_overlay: { args: undefined; result: boolean };
  set_overlay_pinned: { args: { pinned: boolean }; result: void };
  resize_overlay_to_content: { args: { width: number; height: number; keepCenter: boolean }; result: void };
  resize_control_panel_to_content: { args: { width: number; height: number; keepCenter: boolean }; result: void };
  start_overlay_dragging: { args: undefined; result: void };
  is_overlay_dragging: { args: undefined; result: boolean };
  remember_overlay_position: { args: undefined; result: void };
  open_microphone_settings: { args: undefined; result: void };
  start_audio_recording: { args: { deviceId: string | null } | undefined; result: void };
  list_microphones: { args: undefined; result: { id: string; name: string; error: string | null }[] };
  check_microphone: { args: { deviceId: string | null }; result: void };
  get_audio_input_level: { args: undefined; result: number };
  stop_audio_recording: { args: { requestedAtMs: number; afterStopMs: number } | undefined; result: ArrayBuffer };
  snapshot_audio_recording: { args: undefined; result: ArrayBuffer };
  read_audio_pcm_recording: { args: { fromFrame: number }; result: ArrayBuffer };
  deepgram_http: { args: { method: 'GET' | 'POST'; path: string; apiKey: string; contentType?: string; bodyBase64?: string }; result: { status: number; body: string } };
  cancel_audio_recording: { args: undefined; result: void };
  pause_audio_recording: { args: undefined; result: void };
  resume_audio_recording: { args: undefined; result: void };
  set_control_hotkeys: { args: { pauseShortcut: string; cancelShortcut: string }; result: void };
  set_control_hotkeys_active: { args: { active: boolean }; result: void };
  set_record_hotkey: { args: { shortcut: string }; result: void };
  set_scenario_hotkeys: { args: { bindings: { scenarioId: string; shortcut: string }[] }; result: void };
  begin_scenario_output: { args: { runId: string }; result: void };
  finish_scenario_output: { args: { runId: string }; result: void };
  cancel_scenario_output: { args: { runId: string }; result: void };
  copy_text_to_clipboard: { args: { text: string; historyLevel: number; pasteSource: string; runId?: string }; result: void };
  write_clipboard_text: { args: { text: string }; result: void };
  save_recording_file: { args: { filename: string; data: string }; result: boolean };
  get_app_logs: { args: undefined; result: string };
  paste_text_into_active_window: { args: { text: string; returnFocusToOriginalWindow?: boolean; runId?: string }; result: void };
};

type CommandName = keyof CommandContract;
type CommandArgs<K extends CommandName> = CommandContract[K]['args'];

export function invokeCommand<K extends CommandName>(
  invoke: typeof TauriInvoke,
  command: K,
  ...args: undefined extends CommandArgs<K> ? [args?: Exclude<CommandArgs<K>, undefined>] : [args: CommandArgs<K>]
): Promise<CommandContract[K]['result']> {
  const payload = args[0] as Record<string, unknown> | undefined;
  return invoke<CommandContract[K]['result']>(command, payload);
}
