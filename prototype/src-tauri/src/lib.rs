#[cfg(desktop)]
mod app_state;
#[cfg(desktop)]
pub(crate) mod audio_capture;
#[cfg(desktop)]
mod commands;
mod runtime_logs;
#[cfg(desktop)]
mod startup;
#[cfg(target_os = "android")]
mod android_runtime;

#[cfg(desktop)]
pub use crate::commands::{
    open_claude_code,
    cancel_claude_code, claude_code_running,
    start_claude_dictation, stop_claude_dictation, poll_claude_dictation, prepare_claude_code,
    save_recording_file,
    piper_http,
    synthesize_system_speech, system_speech_capabilities,
    edge_speech_voices, edge_speech_stream, edge_speech_prepare, cancel_edge_speech,
    begin_scenario_output, cancel_scenario_output, finish_scenario_output, get_selected_text,
    cancel_audio_recording, copy_text_to_clipboard, write_clipboard_text, get_app_logs, hide_overlay, set_overlay_pinned, is_overlay_dragging, open_microphone_settings,
    paste_text_into_active_window, pause_audio_recording, position_overlay_on_cursor_monitor,
    resume_audio_recording, remember_overlay_position, resize_control_panel_to_content, resize_overlay_to_content, set_control_hotkeys_active, set_control_hotkeys, set_record_hotkey, set_scenario_hotkeys, show_overlay,
    list_microphones, check_microphone, get_audio_input_level, start_audio_recording, start_overlay_dragging, stop_audio_recording, snapshot_audio_recording,
};
#[cfg(desktop)]
mod desktop {
    use crate::*;
    use crate::audio_capture;
use tauri::{
    Manager,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};





use crate::app_state::{ControlHotkeyState, PasteTargetState, RecordHotkeyState, ScenarioHotkeyState};



pub fn run() {
    let mut targets = vec![
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
    ];
    if cfg!(debug_assertions) {
        targets.push(
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Folder {
                path: crate::runtime_logs::dev_logs_dir(),
                file_name: Some("app".to_string()),
            }),
        );
    } else {
        targets.push(crate::runtime_logs::target());
        targets.push(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
            file_name: Some("app".to_string()),
        }));
    }
    // Network crates trace every WebSocket frame: that floods the log and the overlay console.
    let log_plugin = tauri_plugin_log::Builder::default()
        .targets(targets)
        .level_for("tungstenite", log::LevelFilter::Info)
        .level_for("tokio_tungstenite", log::LevelFilter::Info)
        .level_for("rustls", log::LevelFilter::Info)
        .build();

    tauri::Builder::default()
        .plugin(log_plugin)
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(RecordHotkeyState::default())
        .manage(ScenarioHotkeyState::default())
        .manage(ControlHotkeyState::default())
        .manage(PasteTargetState::default())
        .manage(audio_capture::AudioCaptureState::new())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    use tauri::Emitter;
                    use tauri_plugin_global_shortcut::ShortcutState;
                    if event.state != ShortcutState::Pressed {
                        return;
                    }

                    let is_record = app.state::<RecordHotkeyState>().0.lock()
                        .map(|current| current.as_ref() == Some(shortcut)).unwrap_or(false);
                    let scenario_id = app.state::<ScenarioHotkeyState>().0.lock().ok()
                        .and_then(|bindings| bindings.iter().find(|(key, _)| key == shortcut).map(|(_, id)| id.clone()));
                    if is_record || scenario_id.is_some() {
                        #[cfg(windows)]
                        {
                            let foreground = unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow() };
                            let mut foreground_process_id = 0;
                            if !foreground.is_null() {
                                unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(foreground, &mut foreground_process_id) };
                            }
                            let current_process_id = unsafe { windows_sys::Win32::System::Threading::GetCurrentProcessId() };
                            if let Ok(mut target) = app.state::<PasteTargetState>().0.lock() {
                                if target.recording {
                                    target.recording = false;
                                } else if target.hwnd.is_none() {
                                    target.hwnd = if !foreground.is_null() && foreground_process_id != current_process_id {
                                        Some(foreground as isize)
                                    } else {
                                        None
                                    };
                                    target.recording = true;
                                }
                            }
                        }
                        let _ = app.emit_to("overlay", "record-hotkey", scenario_id);
                        return;
                    }

                    let control = app.state::<ControlHotkeyState>();
                    let action = control.0.lock().ok().and_then(|hotkeys| {
                        if !hotkeys.2 { None }
                        else if hotkeys.0.as_ref() == Some(shortcut) { Some("pause-hotkey") }
                        else if hotkeys.1.as_ref() == Some(shortcut) { Some("cancel-hotkey") }
                        else { None }
                    });
                    if let Some(event_name) = action {
                        let _ = app.emit_to("overlay", event_name, ());
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            open_claude_code,
            cancel_claude_code, claude_code_running,
            start_claude_dictation, stop_claude_dictation, poll_claude_dictation, prepare_claude_code,
            save_recording_file,
            piper_http,
            synthesize_system_speech,
            system_speech_capabilities,
            edge_speech_voices, edge_speech_stream, edge_speech_prepare, cancel_edge_speech,
            crate::startup::set_startup_settings,
            position_overlay_on_cursor_monitor,
            show_overlay,
            hide_overlay,
            set_overlay_pinned,
            resize_overlay_to_content,
            resize_control_panel_to_content,
            start_overlay_dragging,
            is_overlay_dragging,
            remember_overlay_position,
            open_microphone_settings,
            begin_scenario_output, get_selected_text,
            cancel_scenario_output,
            finish_scenario_output,
            start_audio_recording,
            list_microphones, check_microphone, get_audio_input_level,
            stop_audio_recording,
            snapshot_audio_recording,
            cancel_audio_recording,
            pause_audio_recording,
            resume_audio_recording,
            set_control_hotkeys_active, set_control_hotkeys,
            set_record_hotkey,
            set_scenario_hotkeys,
            copy_text_to_clipboard,
            write_clipboard_text,
            get_app_logs,
            paste_text_into_active_window
        ])
        .setup(|app| {
            #[cfg(windows)]
            if let Err(error) = crate::commands::overlay_interaction::initialize(app.handle()) {
                log::warn!("Не удалось включить закрепление оверлея: {error}");
            }
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            let default_hotkey: tauri_plugin_global_shortcut::Shortcut = "Ctrl+Shift+D".parse::<tauri_plugin_global_shortcut::Shortcut>().map_err(|e| std::io::Error::other(e.to_string()))?;
            match app.global_shortcut().register(default_hotkey) {
                Ok(()) => *app.state::<RecordHotkeyState>().0.lock().map_err(|e| e.to_string())? = Some(default_hotkey),
                Err(error) => log::warn!("Не удалось зарегистрировать горячую клавишу по умолчанию Ctrl+Shift+D: {error}"),
            }
            let pause_hotkey: tauri_plugin_global_shortcut::Shortcut = "Ctrl+Alt+D".parse::<tauri_plugin_global_shortcut::Shortcut>().map_err(|e| std::io::Error::other(e.to_string()))?;
            let cancel_hotkey: tauri_plugin_global_shortcut::Shortcut = "Escape".parse::<tauri_plugin_global_shortcut::Shortcut>().map_err(|e| std::io::Error::other(e.to_string()))?;
            let control_state = app.state::<ControlHotkeyState>();
            let mut control_keys = control_state.0.lock().map_err(|e| e.to_string())?;
            if control_keys.0.is_none() && control_keys.1.is_none() {
                *control_keys = (Some(pause_hotkey), Some(cancel_hotkey), false);
            }
            drop(control_keys);
            // Создание системного трея (Tray Icon)
            let show_panel = MenuItem::with_id(app, "show_panel", "Панель управления", true, None::<&str>)?;
            let show_rec = MenuItem::with_id(app, "show_overlay", "Оверлей записи", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;

            let menu = Menu::with_items(app, &[&show_panel, &show_rec, &quit])?;

            let _tray = TrayIconBuilder::new()
                .icon(tauri::include_image!("./icons/32x32.png"))
                .menu(&menu)
                .tooltip("Speech to Text")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show_panel" => {
                        if let Some(main_win) = app.get_webview_window("main") {
                            let _ = main_win.set_skip_taskbar(false);
                            let _ = main_win.unminimize();
                            let _ = main_win.show();
                            let _ = main_win.set_focus();
                        }
                    }
                    "show_overlay" => {
                        let _ = show_overlay(app.clone());
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(main_win) = app.get_webview_window("main") {
                            let _ = main_win.set_skip_taskbar(false);
                            let _ = main_win.unminimize();
                            let _ = main_win.show();
                            let _ = main_win.set_focus();
                        }
                    }
                })
                .build(app)?;
            log::info!("Значок системного трея создан");
            if let Err(error) = crate::startup::restore(app.handle()) {
                log::warn!("Не удалось восстановить настройки запуска: {error}");
                if let Some(window) = app.get_webview_window("main") { let _ = window.show(); }
            }

            // Перехват закрытия главной панели (минимизация/скрытие в трей вместо завершения процесса)
            if let Some(main_window) = app.get_webview_window("main") {
                let main_window_clone = main_window.clone();
                main_window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = main_window_clone.hide();
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}

}
#[cfg(desktop)]
pub use desktop::run;
#[cfg(target_os = "android")]
#[tauri::mobile_entry_point]
pub fn run() { android_runtime::run(); }
