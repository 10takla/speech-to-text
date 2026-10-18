#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SpeechSettings { voice_id: String, language: String, rate: f64, pitch: f64 }
impl Default for SpeechSettings {
    fn default() -> Self { Self { voice_id: String::new(), language: String::new(), rate: 1.0, pitch: 1.0 } }
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechVoice { id: String, name: String, language: String }
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechCapabilities { voices: Vec<SpeechVoice>, default_voice_id: String }

#[tauri::command]
pub async fn system_speech_capabilities() -> Result<SpeechCapabilities, String> {
    tauri::async_runtime::spawn_blocking(capabilities).await.map_err(|error| error.to_string())?
}

#[cfg(windows)]
fn capabilities() -> Result<SpeechCapabilities, String> {
    with_engine(|_engine| {
        use windows::Media::SpeechSynthesis::SpeechSynthesizer;
        let installed = SpeechSynthesizer::AllVoices()?;
        let mut voices = Vec::new();
        for index in 0..installed.Size()? {
            let voice = installed.GetAt(index)?;
            voices.push(SpeechVoice { id: voice.Id()?.to_string(), name: voice.DisplayName()?.to_string(), language: voice.Language()?.to_string() });
        }
        Ok(SpeechCapabilities { voices, default_voice_id: SpeechSynthesizer::DefaultVoice()?.Id()?.to_string() })
    })
}
#[cfg(not(windows))]
fn capabilities() -> Result<SpeechCapabilities, String> { Err("Системные голоса доступны в Windows и Android.".into()) }

#[tauri::command]
pub async fn synthesize_system_speech(text: String, settings: Option<SpeechSettings>) -> Result<Vec<u8>, String> {
    if text.trim().is_empty() { return Err("Нет текста для озвучки.".into()); }
    tauri::async_runtime::spawn_blocking(move || synthesize(text, settings.unwrap_or_default()))
        .await.map_err(|error| error.to_string())?
}

#[cfg(windows)]
fn with_engine<T>(operation: impl FnOnce(windows::Media::SpeechSynthesis::SpeechSynthesizer) -> windows::core::Result<T>) -> Result<T, String> {
    use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};
    unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.map_err(|error| error.to_string())?;
    struct Apartment;
    impl Drop for Apartment { fn drop(&mut self) { unsafe { RoUninitialize(); } } }
    let _apartment = Apartment;
    operation(windows::Media::SpeechSynthesis::SpeechSynthesizer::new().map_err(|error| error.to_string())?).map_err(|error| error.to_string())
}

#[cfg(windows)]
fn synthesize(text: String, settings: SpeechSettings) -> Result<Vec<u8>, String> {
    use windows::{Media::SpeechSynthesis::SpeechSynthesizer, Storage::Streams::DataReader, core::HSTRING};
    if !settings.rate.is_finite() || !(0.5..=2.0).contains(&settings.rate) || !settings.pitch.is_finite() || !(0.5..=2.0).contains(&settings.pitch) {
        return Err("Скорость и высота голоса должны быть от 0,5 до 2.".into());
    }
    with_engine(|engine| {
        if !settings.voice_id.is_empty() || !settings.language.is_empty() {
            let voices = SpeechSynthesizer::AllVoices()?;
            let mut selected = None;
            for index in 0..voices.Size()? {
                let voice = voices.GetAt(index)?;
                if (!settings.voice_id.is_empty() && voice.Id()?.to_string() == settings.voice_id)
                    || (settings.voice_id.is_empty() && voice.Language()?.to_string() == settings.language) {
                    selected = Some(voice); break;
                }
            }
            let voice = selected.ok_or_else(|| windows::core::Error::new(windows::core::HRESULT(0x80070057u32 as i32), "Выбранный голос или язык недоступен."))?;
            engine.SetVoice(&voice)?;
        }
        let options = engine.Options()?;
        options.SetSpeakingRate(settings.rate)?;
        options.SetAudioPitch(settings.pitch)?;
        let stream = engine.SynthesizeTextToStreamAsync(&HSTRING::from(text))?.join()?;
        let size = u32::try_from(stream.Size()?).map_err(|_| windows::core::Error::from_hresult(windows::core::HRESULT(0x8007000Eu32 as i32)))?;
        let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0)?)?;
        reader.LoadAsync(size)?.join()?;
        let mut bytes = vec![0; size as usize];
        reader.ReadBytes(&mut bytes)?;
        Ok(bytes)
    }).map_err(|error| format!("Не удалось создать озвучку системным движком: {error}"))
}

#[cfg(not(windows))]
fn synthesize(_text: String, _settings: SpeechSettings) -> Result<Vec<u8>, String> {
    Err("Системная озвучка на этой платформе недоступна.".into())
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn discovers_voices_without_synthesis() {
        let capabilities = super::capabilities().expect("Windows voice enumeration should succeed");
        assert!(!capabilities.default_voice_id.is_empty());
        assert!(capabilities.voices.iter().any(|voice| voice.id == capabilities.default_voice_id));
    }
    #[test]
    fn synthesizes_audio() {
        let audio = super::synthesize("Проверка озвучки".into(), super::SpeechSettings::default()).expect("Windows system voice must synthesize speech");
        assert!(audio.len() > 44);
        assert_eq!(&audio[..4], b"RIFF");
        assert_eq!(&audio[8..12], b"WAVE");
    }
}
