#[derive(Default)]
pub struct RecordHotkeyState(pub(crate) std::sync::Mutex<Option<tauri_plugin_global_shortcut::Shortcut>>);

#[derive(Default)]
pub struct ControlHotkeyState(pub(crate) std::sync::Mutex<(Option<tauri_plugin_global_shortcut::Shortcut>, Option<tauri_plugin_global_shortcut::Shortcut>)>);

#[derive(Default)]
pub(crate) struct PasteTarget {
    pub(crate) hwnd: Option<isize>,
    pub(crate) recording: bool,
}

#[derive(Default)]
pub struct PasteTargetState(pub(crate) std::sync::Mutex<PasteTarget>);
