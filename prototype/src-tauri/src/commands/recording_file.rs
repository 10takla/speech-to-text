use std::path::PathBuf;

#[tauri::command]
pub async fn save_recording_file(
    window: tauri::WebviewWindow,
    filename: String,
    data: String,
) -> Result<bool, String> {
    #[cfg(windows)]
    {
        let owner = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
        tauri::async_runtime::spawn_blocking(move || {
            // Shell dialogs run in their own STA; Tokio workers may already be MTA.
            std::thread::spawn(move || {
                use base64::Engine;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(data).map_err(|_| "Не удалось прочитать аудиозапись.".to_string())?;
                if bytes.is_empty() { return Err("Аудиозапись пуста.".into()); }
                save_to_selected_file(&bytes, || choose_file(owner, &filename))
            }).join().map_err(|_| "Окно сохранения завершилось с ошибкой.".to_string())?
        }).await.map_err(|error| error.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = (window, filename, data);
        Err("Системное сохранение аудиозаписи поддерживается в Windows.".into())
    }
}

fn save_to_selected_file(
    bytes: &[u8],
    choose: impl FnOnce() -> Result<Option<PathBuf>, String>,
) -> Result<bool, String> {
    let Some(path) = choose()? else { return Ok(false); };
    std::fs::write(path, bytes).map_err(|error| format!("Не удалось сохранить аудиозапись: {error}"))?;
    Ok(true)
}

#[cfg(windows)]
fn choose_file(owner: isize, filename: &str) -> Result<Option<PathBuf>, String> {
    use std::os::windows::ffi::OsStringExt;
    use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_SINGLETHREADED};
    use windows_sys::Win32::UI::Controls::Dialogs::{
        CommDlgExtendedError, GetSaveFileNameW, OPENFILENAMEW,
        OFN_EXPLORER, OFN_NOCHANGEDIR, OFN_OVERWRITEPROMPT, OFN_PATHMUSTEXIST,
    };
    unsafe { RoInitialize(RO_INIT_SINGLETHREADED) }.map_err(|error| error.to_string())?;
    struct Apartment;
    impl Drop for Apartment { fn drop(&mut self) { unsafe { RoUninitialize() }; } }
    let _apartment = Apartment;
    let name = std::path::Path::new(filename).file_name().and_then(|name| name.to_str())
        .unwrap_or("recording.wav");
    let encoded: Vec<u16> = name.encode_utf16().collect();
    let mut path = vec![0u16; 32_768];
    if encoded.contains(&0) || encoded.len() >= path.len() {
        return Err("Недопустимое имя аудиофайла.".into());
    }
    path[..encoded.len()].copy_from_slice(&encoded);
    let extension = std::path::Path::new(name).extension().and_then(|value| value.to_str()).unwrap_or("wav");
    let filter: Vec<u16> = format!("Аудиозапись\0*.{extension}\0Все файлы\0*.*\0\0").encode_utf16().collect();
    let extension: Vec<u16> = extension.encode_utf16().chain(Some(0)).collect();
    let title: Vec<u16> = "Сохранить аудиозапись\0".encode_utf16().collect();
    let mut dialog = OPENFILENAMEW {
        lStructSize: std::mem::size_of::<OPENFILENAMEW>() as u32,
        hwndOwner: owner as _,
        lpstrFilter: filter.as_ptr(),
        nFilterIndex: 1,
        lpstrFile: path.as_mut_ptr(),
        nMaxFile: path.len() as u32,
        lpstrTitle: title.as_ptr(),
        lpstrDefExt: extension.as_ptr(),
        Flags: OFN_EXPLORER | OFN_NOCHANGEDIR | OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST,
        ..Default::default()
    };
    if unsafe { GetSaveFileNameW(&mut dialog) } == 0 {
        let error = unsafe { CommDlgExtendedError() };
        return if error == 0 { Ok(None) }
            else { Err(format!("Не удалось открыть окно сохранения (0x{error:08X}).")) };
    }
    let length = path.iter().position(|unit| *unit == 0).unwrap_or(path.len());
    Ok(Some(std::ffi::OsString::from_wide(&path[..length]).into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancelled_selection_does_not_save() {
        assert_eq!(save_to_selected_file(b"audio", || Ok(None)), Ok(false));
    }

    #[test]
    fn saves_exact_audio_bytes_and_reports_write_errors() {
        let path = std::env::temp_dir().join(format!("stt-recording-test-{}.wav", std::process::id()));
        let bytes = b"RIFF\0\xFFaudio";
        assert_eq!(save_to_selected_file(bytes, || Ok(Some(path.clone()))), Ok(true));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        std::fs::remove_file(&path).unwrap();
        assert!(save_to_selected_file(bytes, || Ok(Some(path.join("missing.wav"))))
            .unwrap_err().contains("Не удалось сохранить"));
    }
}
