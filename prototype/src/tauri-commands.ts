import type { invoke as TauriInvoke } from '@tauri-apps/api/core';

type CommandContract = {
  open_claude_code: { args: undefined; result: void };
  cancel_claude_code: { args: { runId: string } | undefined; result: void };
  start_claude_dictation: { args: { runId: string }; result: void };
  stop_claude_dictation: { args: { runId: string }; result: string };
  prepare_claude_code: { args: { enabled: boolean }; result: void };
  poll_claude_dictation: { args: { runId: string; live: boolean }; result: { finished: boolean; text: string | null } };
  claude_code_running: { args: undefined; result: boolean };
  get_selected_text: { args: { runId: string }; result: string };
  set_startup_settings: { args: { settings: { startupMode: '' | 'window' | 'hidden-taskbar' | 'tray' } }; result: void };
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
  copy_text_to_clipboard: { args: { text: string; historyLevel: number; runId?: string }; result: void };
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
