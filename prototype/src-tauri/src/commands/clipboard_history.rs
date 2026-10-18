use std::time::{Duration, Instant};
use windows::ApplicationModel::DataTransfer::{
    Clipboard, ClipboardContentOptions, ClipboardHistoryItem, ClipboardHistoryItemsResultStatus,
    DataPackage, DataPackageView, StandardDataFormats,
};
use windows::Win32::System::WinRT::{RO_INIT_SINGLETHREADED, RoInitialize, RoUninitialize};
use windows::core::HSTRING;

const OPERATION_TIMEOUT: Duration = Duration::from_secs(2);
const CLIPBOARD_RETRY_TIMEOUT: Duration = Duration::from_millis(500);
const CLIPBRD_E_CANT_OPEN: windows::core::HRESULT = windows::core::HRESULT(0x800401D0u32 as i32);
std::thread_local! {
    static DEADLINE: std::cell::Cell<Option<Instant>> = const { std::cell::Cell::new(None) };
}

fn check_deadline() -> Result<(), String> {
    if DEADLINE.with(|value| value.get().is_some_and(|limit| Instant::now() >= limit)) {
        Err("Windows не успела обработать историю буфера обмена за 2 секунды.".into())
    } else {
        Ok(())
    }
}

// WinRT clipboard operations run in STA. Pump its messages while waiting,
// rather than blocking the apartment with IAsyncOperation::join().
macro_rules! await_winrt {
    ($operation:expr) => {{
        check_deadline()?;
        let operation = $operation.map_err(|error| error.to_string())?;
        while operation.Status().map_err(|error| error.to_string())?.0 == 0 {
            if let Err(error) = check_deadline() {
                let _ = operation.Cancel();
                return Err(error);
            }
            pump_messages();
            std::thread::sleep(Duration::from_millis(5));
        }
        operation.GetResults().map_err(|error| error.to_string())
    }};
}

fn pump_messages() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, MSG, PM_REMOVE, PeekMessageW, TranslateMessage,
    };
    let mut message = MSG::default();
    unsafe {
        while PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}

fn retry_clipboard<T>(operation: impl FnMut() -> windows::core::Result<T>) -> Result<T, String> {
    let until = Instant::now() + CLIPBOARD_RETRY_TIMEOUT;
    retry_clipboard_with(operation, || {
        if Instant::now() >= until || check_deadline().is_err() {
            return false;
        }
        pump_messages();
        std::thread::sleep(Duration::from_millis(10));
        true
    })
}

fn retry_clipboard_with<T>(
    mut operation: impl FnMut() -> windows::core::Result<T>,
    mut wait: impl FnMut() -> bool,
) -> Result<T, String> {
    loop {
        match operation() {
            Ok(value) => return Ok(value),
            Err(error) if error.code() == CLIPBRD_E_CANT_OPEN && wait() => {}
            Err(error) => return Err(error.to_string()),
        }
    }
}

fn if_clipboard_unchanged<T>(
    expected: Option<u32>,
    current: u32,
    operation: impl FnOnce() -> windows::core::Result<T>,
) -> windows::core::Result<Option<T>> {
    if expected.is_some_and(|sequence| sequence != current) {
        Ok(None)
    } else {
        operation().map(Some)
    }
}

struct Apartment;

impl Apartment {
    fn initialize() -> Result<Self, String> {
        unsafe { RoInitialize(RO_INIT_SINGLETHREADED) }.map_err(|error| error.to_string())?;
        Ok(Self)
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { RoUninitialize() };
    }
}

struct SavedItem {
    id: HSTRING,
    text: Option<HSTRING>,
    html: Option<HSTRING>,
    bitmap: Option<Vec<u8>>,
    content: DataPackage,
}

static CLIPBOARD_OPERATION: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Default)]
struct RecordingClipboard {
    sequence: Option<u32>,
    user_copied: bool,
}

impl RecordingClipboard {
    fn changed(&self, sequence: u32) -> bool {
        self.sequence.is_some_and(|previous| previous != sequence)
    }

    fn observe(&mut self, sequence: u32) -> bool {
        if self.changed(sequence) {
            self.user_copied = true;
        }
        self.user_copied
    }

    fn own_write(&mut self, before: u32, after: u32) {
        self.observe(before);
        if self.sequence.is_some() {
            self.sequence = Some(after);
        }
    }
}

static RECORDING_CLIPBOARD: std::sync::Mutex<RecordingClipboard> =
    std::sync::Mutex::new(RecordingClipboard { sequence: None, user_copied: false });

pub fn begin_recording() {
    if let Ok(mut recording) = RECORDING_CLIPBOARD.lock() {
        *recording = RecordingClipboard { sequence: Some(clipboard_sequence()), user_copied: false };
    }
}

pub fn end_recording() {
    if let Ok(mut recording) = RECORDING_CLIPBOARD.lock() {
        *recording = RecordingClipboard::default();
    }
}

fn record_own_write(before: u32, after: u32) {
    if let Ok(mut recording) = RECORDING_CLIPBOARD.lock() {
        recording.own_write(before, after);
    }
}

struct SavedClipboard {
    content: DataPackage,
    empty: bool,
    plain_text: Option<HSTRING>,
}

fn snapshot_clipboard() -> Result<(u32, SavedClipboard), String> {
    loop {
        check_deadline()?;
        let sequence = clipboard_sequence();
        let view = retry_clipboard(Clipboard::GetContent)?;
        let formats = view.AvailableFormats().map_err(|error| error.to_string())?;
        let count = formats.Size().map_err(|error| error.to_string())?;
        let plain_text = if count == 1
            && formats.GetAt(0).map_err(|error| error.to_string())?
                == StandardDataFormats::Text().map_err(|error| error.to_string())?
        {
            Some(await_winrt!(view.GetTextAsync())?)
        } else {
            None
        };
        let content = DataPackage::new().map_err(|error| error.to_string())?;
        if let Some(text) = &plain_text {
            content.SetText(text).map_err(|error| error.to_string())?;
        } else {
            for format in formats {
                let data = await_winrt!(view.GetDataAsync(&format))?;
                content.SetData(&format, &data).map_err(|error| error.to_string())?;
            }
        }
        if clipboard_sequence() == sequence {
            return Ok((sequence, SavedClipboard { content, empty: count == 0, plain_text }));
        }
    }
}

// Only the sequence number lives across operations. Rich clipboard snapshots
// stay on this STA thread and are taken only when a user copy must be preserved.
struct CopyClipboard {
    sequence: u32,
    restore: Option<SavedClipboard>,
}

impl CopyClipboard {
    fn new() -> Result<Self, String> {
        let sequence = clipboard_sequence();
        let preserve = RECORDING_CLIPBOARD.lock().map_err(|error| error.to_string())?
            .observe(sequence);
        let mut clipboard = Self { sequence, restore: None };
        if preserve {
            let (sequence, saved) = snapshot_clipboard()?;
            clipboard.sequence = sequence;
            clipboard.restore = Some(saved);
        }
        Ok(clipboard)
    }

    fn observe(&mut self) -> Result<(), String> {
        let current = clipboard_sequence();
        if current != self.sequence {
            let external = {
                let mut recording = RECORDING_CLIPBOARD.lock().map_err(|error| error.to_string())?;
                let external = recording.sequence.is_none() || recording.changed(current);
                recording.observe(current);
                external
            };
            // A publish can succeed before its Flush fails. Do not mistake that
            // partial own write for a new user copy during error cleanup.
            if !external {
                self.sequence = current;
                return Ok(());
            }
            let (sequence, saved) = snapshot_clipboard()?;
            RECORDING_CLIPBOARD.lock().map_err(|error| error.to_string())?.observe(sequence);
            self.sequence = sequence;
            self.restore = Some(saved);
        }
        Ok(())
    }

    fn publish(&mut self, content: &DataPackage, history: bool) -> Result<(), String> {
        loop {
            check_deadline()?;
            self.observe()?;
            if let Some(sequence) = publish_if_unchanged(content, history, Some(self.sequence))? {
                self.sequence = sequence;
                return Ok(());
            }
        }
    }

    fn write_text(&mut self, text: &str, history: bool) -> Result<(), String> {
        self.publish(&text_content(text)?, history)
    }

    fn finish(&mut self, text: &str) -> Result<(), String> {
        loop {
            // Cleanup also needs a chance after the history operation times out.
            self.observe()?;
            let sequence = if let Some(saved) = &self.restore {
                if saved.empty {
                    clear_if_unchanged(self.sequence)?
                } else {
                    publish_if_unchanged(&saved.content, false, Some(self.sequence))?
                }
            } else {
                publish_if_unchanged(&text_content(text)?, false, Some(self.sequence))?
            };
            if let Some(sequence) = sequence {
                self.sequence = sequence;
                return Ok(());
            }
            check_deadline()?;
        }
    }
}

pub fn copy_at_level(text: &str, level: i64) -> Result<(), String> {
    let started = Instant::now();
    log::info!(
        "clipboard: start level={level}, utf16_units={}",
        text.encode_utf16().count()
    );
    let result = on_clipboard_thread(|| {
        let mut clipboard = CopyClipboard::new()?;
        let result = copy_text_at_level(text, level, &mut clipboard);
        let restore = clipboard.finish(text);
        match (result, restore) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
            (Err(error), Err(restore)) => Err(format!(
                "{error} Не удалось восстановить текущее содержимое буфера: {restore}"
            )),
        }
    });
    match &result {
        Ok(()) => log::info!(
            "clipboard: completed in {} ms",
            started.elapsed().as_millis()
        ),
        Err(error) => log::warn!(
            "clipboard: failed after {} ms: {error}",
            started.elapsed().as_millis()
        ),
    }
    result
}

fn copy_text_at_level(text: &str, level: i64, clipboard: &mut CopyClipboard) -> Result<(), String> {
    // Windows keeps up to 25 history entries; reserve one slot for the new text.
    let depth = level.unsigned_abs().min(24) as usize;
    if depth == 0 {
        clipboard.write_text(text, true)?;
        // History captures clipboard content asynchronously. A following paste
        // replaces it with history-excluded content, so wait before returning.
        // Ordinary copying must still work when Windows history is disabled.
        if Clipboard::IsHistoryEnabled().map_err(|error| error.to_string())? {
            validate_history_text(text)?;
            wait_for_item(
                0,
                "добавление текста на уровень 0",
                |item| is_plain_text(item, text),
            )?;
        }
        return Ok(());
    }

    if !Clipboard::IsHistoryEnabled().map_err(|error| error.to_string())? {
        return Err(
            "Включите историю буфера обмена в настройках Windows или выберите уровень 0.".into(),
        );
    }
    validate_history_text(text)?;

    // Capture the entries that must stay above the new text, including their formats.
    // Skip a previous copy of this text so that it cannot occupy two levels.
    let mut saved = Vec::new();
    log::info!("clipboard: stage=сохранение предыдущих записей, depth={depth}");
    for item in history()? {
        if item_text(&item)?
            .as_ref()
            .is_some_and(|value| same_text(value, text))
        {
            continue;
        }
        saved.push(save_item(&item)?);
        if saved.len() == depth {
            break;
        }
    }

    clipboard.write_text(text, true)?;
    let result = (|| {
        wait_for_item(0, "добавление текста", |item| {
            is_plain_text(item, text)
        })?;
        // Recopy from the lower entry upwards to retain the original order.
        for item in saved.iter().rev() {
            clipboard.publish(&item.content, true)?;
            wait_for_item(
                0,
                "восстановление предыдущей записи",
                |current| {
                    Ok(current.Id().map_err(|error| error.to_string())? == item.id
                        || ((item.text.is_some() || item.html.is_some() || item.bitmap.is_some())
                            && item_text(current)? == item.text
                            && item_html(current)? == item.html
                            && item_bitmap(current)? == item.bitmap))
                },
            )?;
        }
        wait_for_item(
            saved.len(),
            "проверка позиции текста",
            |item| is_plain_text(item, text),
        )
    })();

    // The current Ctrl+V content is selected separately, without adding it again to history.
    result
}

fn validate_history_text(text: &str) -> Result<(), String> {
    if text.is_empty() || (text.encode_utf16().count() + 1) * 2 > 4 * 1024 * 1024 {
        Err("Текст пуст или превышает ограничение истории Windows (4 МБ).".into())
    } else {
        Ok(())
    }
}

pub fn with_text_for_paste(
    text: &str,
    paste: impl FnOnce() -> Result<(), String> + Send,
) -> Result<(), String> {
    let started = Instant::now();
    let result = on_clipboard_thread(|| {
        let content = text_content(text)?;
        let (sequence, saved) = loop {
            // Retry the snapshot if a user copy arrives before publication.
            let (before, saved) = snapshot_clipboard()?;
            // Identical plain text needs neither replacement nor restoration.
            // Still wait for the receiver before another scenario step can write.
            if saved.plain_text.as_ref().is_some_and(|current| current == &HSTRING::from(text)) {
                log::info!("paste: clipboard already contains identical plain text");
                let result = paste();
                log::info!("paste: input sent after {} ms", started.elapsed().as_millis());
                wait_for_paste_reader(before);
                return result;
            }
            if let Some(sequence) = publish_if_unchanged(&content, false, Some(before))? {
                if clipboard_sequence() == sequence {
                    break (sequence, saved);
                }
            }
            check_deadline()?;
        };
        let result = paste();
        log::info!("paste: input sent after {} ms", started.elapsed().as_millis());
        // SendInput queues Ctrl+V; give the receiver time to read the temporary
        // content before restoring it, including after partial input failure.
        wait_for_paste_reader(sequence);
        // A copy made by the user or another app during paste takes precedence.
        if clipboard_sequence() == sequence {
            let restore = if saved.empty {
                clear_if_unchanged(sequence).map(|_| ())
            } else {
                publish_if_unchanged(&saved.content, false, Some(sequence)).map(|_| ())
            };
            if let Err(error) = restore {
                log::warn!("Не удалось восстановить буфер после вставки: {error}");
                // Cleanup must not replace the actual input failure.
                result?;
                return Err(format!(
                    "Команда вставки отправлена, но не удалось восстановить буфер: {error}"
                ));
            }
        }
        result
    });
    log::info!(
        "paste: completed in {} ms, success={}",
        started.elapsed().as_millis(), result.is_ok()
    );
    result
}

fn wait_for_paste_reader(sequence: u32) {
    let until = Instant::now() + Duration::from_millis(500);
    while Instant::now() < until && clipboard_sequence() == sequence {
        pump_messages();
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn clipboard_sequence() -> u32 {
    unsafe { windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber() }
}

fn on_clipboard_thread(
    operation: impl FnOnce() -> Result<(), String> + Send,
) -> Result<(), String> {
    // Clipboard WinRT classes require STA; pooled worker threads may already use MTA.
    std::thread::scope(|scope| {
        scope
            .spawn(|| {
                DEADLINE.with(|value| value.set(Some(Instant::now() + OPERATION_TIMEOUT)));
                let _operation = loop {
                    match CLIPBOARD_OPERATION.try_lock() {
                        Ok(guard) => break guard,
                        Err(std::sync::TryLockError::WouldBlock) => {
                            check_deadline()
                                .map_err(|_| "Буфер обмена занят другой операцией.".to_string())?;
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => return Err(error.to_string()),
                    }
                };
                let _apartment = Apartment::initialize()?;
                operation()
            })
            .join()
            .map_err(|_| "Обработчик буфера обмена завершился с ошибкой.".to_string())?
    })
}

fn text_content(text: &str) -> Result<DataPackage, String> {
    let content = DataPackage::new().map_err(|error| error.to_string())?;
    content
        .SetText(&HSTRING::from(text))
        .map_err(|error| error.to_string())?;
    Ok(content)
}

fn clear_if_unchanged(expected: u32) -> Result<Option<u32>, String> {
    retry_clipboard(|| {
        if_clipboard_unchanged(Some(expected), clipboard_sequence(), || {
            Clipboard::Clear()?;
            let sequence = clipboard_sequence();
            record_own_write(expected, sequence);
            Ok(sequence)
        })
    })
}

fn publish_if_unchanged(
    content: &DataPackage,
    include_in_history: bool,
    expected_sequence: Option<u32>,
) -> Result<Option<u32>, String> {
    let options = ClipboardContentOptions::new().map_err(|error| error.to_string())?;
    options
        .SetIsAllowedInHistory(include_in_history)
        .map_err(|error| error.to_string())?;
    let sequence = match retry_clipboard(|| {
        let before = clipboard_sequence();
        if_clipboard_unchanged(expected_sequence, before, || {
            if !Clipboard::SetContentWithOptions(content, &options)? {
                return Err(windows::core::Error::new(
                    windows::core::HRESULT(0x80004005u32 as i32),
                    "Windows не разрешила изменить буфер обмена.",
                ));
            }
            let sequence = clipboard_sequence();
            record_own_write(before, sequence);
            Ok(sequence)
        })
    })? {
        None => return Ok(None), // Another copy took precedence while waiting for access.
        Some(sequence) => sequence,
    };
    let flushed = retry_clipboard(|| {
        if_clipboard_unchanged(Some(sequence), clipboard_sequence(), || {
            Clipboard::Flush()?;
            let after = clipboard_sequence();
            record_own_write(sequence, after);
            Ok(after)
        })
    })?;
    Ok(Some(flushed.unwrap_or(sequence)))
}

fn history() -> Result<Vec<ClipboardHistoryItem>, String> {
    let result = await_winrt!(Clipboard::GetHistoryItemsAsync())?;
    match result.Status().map_err(|error| error.to_string())? {
        ClipboardHistoryItemsResultStatus::Success => {}
        ClipboardHistoryItemsResultStatus::ClipboardHistoryDisabled => {
            return Err(
                "Включите историю буфера обмена в настройках Windows или выберите уровень 0."
                    .into(),
            );
        }
        _ => return Err("Windows не разрешила доступ к истории буфера обмена.".into()),
    }
    let items = result.Items().map_err(|error| error.to_string())?;
    let mut history = Vec::new();
    for index in 0..items.Size().map_err(|error| error.to_string())? {
        history.push(items.GetAt(index).map_err(|error| error.to_string())?);
    }
    Ok(history)
}

fn item_text(item: &ClipboardHistoryItem) -> Result<Option<HSTRING>, String> {
    let content = item.Content().map_err(|error| error.to_string())?;
    let text_format = StandardDataFormats::Text().map_err(|error| error.to_string())?;
    if !content
        .Contains(&text_format)
        .map_err(|error| error.to_string())?
    {
        return Ok(None);
    }
    await_winrt!(content.GetTextAsync()).map(Some)
}

fn save_item(item: &ClipboardHistoryItem) -> Result<SavedItem, String> {
    let view = item.Content().map_err(|error| error.to_string())?;
    Ok(SavedItem {
        id: item.Id().map_err(|error| error.to_string())?,
        text: item_text(item)?,
        html: item_html(item)?,
        bitmap: item_bitmap(item)?,
        content: save_content(&view)?,
    })
}

fn item_html(item: &ClipboardHistoryItem) -> Result<Option<HSTRING>, String> {
    let view = item.Content().map_err(|error| error.to_string())?;
    if view
        .Contains(&StandardDataFormats::Html().map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?
    {
        await_winrt!(view.GetHtmlFormatAsync()).map(Some)
    } else {
        Ok(None)
    }
}

fn is_plain_text(item: &ClipboardHistoryItem, text: &str) -> Result<bool, String> {
    Ok(item_text(item)?
        .as_ref()
        .is_some_and(|value| same_text(value, text))
        && item_html(item)?.is_none())
}

fn same_text(value: &HSTRING, text: &str) -> bool {
    value.to_string_lossy().replace("\r\n", "\n") == text.replace("\r\n", "\n")
}

fn item_bitmap(item: &ClipboardHistoryItem) -> Result<Option<Vec<u8>>, String> {
    use windows::Storage::Streams::DataReader;
    let view = item.Content().map_err(|error| error.to_string())?;
    if !view
        .Contains(&StandardDataFormats::Bitmap().map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?
    {
        return Ok(None);
    }
    let bitmap = await_winrt!(view.GetBitmapAsync())?;
    let stream = await_winrt!(bitmap.OpenReadAsync())?;
    let size = u32::try_from(stream.Size().map_err(|error| error.to_string())?)
        .map_err(|_| "Изображение в истории буфера обмена слишком велико.".to_string())?;
    let reader = DataReader::CreateDataReader(&stream).map_err(|error| error.to_string())?;
    let loaded = await_winrt!(reader.LoadAsync(size))?;
    if loaded != size {
        return Err("Windows не прочитала изображение из истории буфера обмена полностью.".into());
    }
    let mut bytes = vec![0; size as usize];
    reader
        .ReadBytes(&mut bytes)
        .map_err(|error| error.to_string())?;
    Ok(Some(bytes))
}

fn save_content(view: &DataPackageView) -> Result<DataPackage, String> {
    let content = DataPackage::new().map_err(|error| error.to_string())?;
    // Only the formats supported by Windows clipboard history. Copy their data,
    // not monitor-exclusion flags, history IDs or delayed raw data providers.
    if view
        .Contains(&StandardDataFormats::Text().map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?
    {
        content
            .SetText(&await_winrt!(view.GetTextAsync())?)
            .map_err(|error| error.to_string())?;
    }
    if view
        .Contains(&StandardDataFormats::Html().map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?
    {
        content
            .SetHtmlFormat(&await_winrt!(view.GetHtmlFormatAsync())?)
            .map_err(|error| error.to_string())?;
    }
    if view
        .Contains(&StandardDataFormats::Bitmap().map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?
    {
        content
            .SetBitmap(&await_winrt!(view.GetBitmapAsync())?)
            .map_err(|error| error.to_string())?;
    }
    Ok(content)
}

fn wait_for_item(
    index: usize,
    stage: &str,
    matches: impl Fn(&ClipboardHistoryItem) -> Result<bool, String>,
) -> Result<(), String> {
    let started = Instant::now();
    log::info!("clipboard: waiting stage={stage}, index={index}");
    loop {
        // Even an already completed WinRT read needs a pumped STA: clipboard
        // history can request delayed content from this publishing thread.
        pump_messages();
        if let Err(error) = check_deadline() {
            log::warn!(
                "clipboard: timeout stage={stage}, index={index}, elapsed_ms={}",
                started.elapsed().as_millis()
            );
            return Err(error);
        }
        if let Some(item) = history()?.get(index) {
            if matches(item)? {
                log::info!(
                    "clipboard: stage={stage}, index={index}, elapsed_ms={}",
                    started.elapsed().as_millis()
                );
                return Ok(());
            }
        }
        pump_messages();
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recording(sequence: u32) -> RecordingClipboard {
        RecordingClipboard { sequence: Some(sequence), user_copied: false }
    }

    #[test]
    fn transcript_becomes_current_when_nothing_was_copied() {
        let mut clipboard = recording(7);
        assert!(!clipboard.observe(7));
        // Publish the transcript, reorder history, then select the current text.
        for before in 7..11 {
            clipboard.own_write(before, before + 1);
        }
        assert!(!clipboard.observe(11));
    }

    #[test]
    fn manual_copy_during_recording_or_processing_keeps_priority() {
        let mut clipboard = recording(7);
        assert!(clipboard.observe(8));
        // History reordering and automatic paste must not erase this decision.
        clipboard.own_write(8, 9);
        clipboard.own_write(9, 10);
        assert!(clipboard.observe(10));
        assert!(!clipboard.changed(10));
    }

    #[test]
    fn automatic_paste_before_copy_is_not_a_manual_copy() {
        let mut clipboard = recording(7);
        clipboard.own_write(7, 8); // Temporary text for Ctrl+V.
        clipboard.own_write(8, 9); // Restore the previous formats (or empty clipboard).
        assert!(!clipboard.observe(9));
    }

    #[test]
    fn manual_copy_between_scenario_actions_is_detected() {
        let mut clipboard = recording(7);
        clipboard.own_write(7, 8);
        clipboard.own_write(8, 9);
        assert!(clipboard.observe(10));
        clipboard.own_write(10, 11);
        assert!(clipboard.observe(11));
    }

    #[test]
    fn manual_copy_during_a_write_is_detected_before_the_next_own_write() {
        let mut clipboard = recording(7);
        clipboard.own_write(7, 8);
        clipboard.own_write(9, 10); // Sequence 9 was an intervening user copy.
        assert!(clipboard.observe(10));
    }

    #[test]
    fn a_new_recording_resets_manual_copy_priority() {
        let mut clipboard = recording(7);
        assert!(clipboard.observe(8));
        clipboard = recording(8);
        assert!(!clipboard.observe(8));
    }

    #[test]
    fn own_write_remains_own_even_if_later_flushing_fails() {
        let mut clipboard = recording(7);
        clipboard.own_write(7, 8);
        assert!(!clipboard.changed(8));
        assert!(!clipboard.observe(8));
        assert!(clipboard.changed(9));
    }

    #[test]
    fn sequence_wraparound_still_detects_a_new_copy() {
        let mut clipboard = recording(u32::MAX);
        assert!(clipboard.observe(0));
    }

    #[test]
    fn retries_temporary_clipboard_locks_without_repeating_paste() {
        let mut attempts = 0;
        let mut waits = 0;
        let result = retry_clipboard_with(
            || {
                attempts += 1;
                if attempts < 3 {
                    Err(windows::core::Error::from_hresult(CLIPBRD_E_CANT_OPEN))
                } else {
                    Ok(())
                }
            },
            || {
                waits += 1;
                true
            },
        );
        assert!(result.is_ok());
        assert_eq!(attempts, 3);
        assert_eq!(waits, 2);
    }

    #[test]
    fn clipboard_retries_stop_when_the_wait_budget_is_exhausted() {
        let mut attempts = 0;
        let mut waits = 0;
        let result: Result<(), String> = retry_clipboard_with(
            || {
                attempts += 1;
                Err(windows::core::Error::from_hresult(CLIPBRD_E_CANT_OPEN))
            },
            || {
                waits += 1;
                waits < 3
            },
        );
        assert!(result.is_err());
        assert_eq!(attempts, 3);
    }

    #[test]
    fn unrelated_clipboard_errors_are_not_retried() {
        let result: Result<(), String> = retry_clipboard_with(
            || {
                Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                    0x80004005u32 as i32,
                )))
            },
            || panic!("Only a busy clipboard may be retried"),
        );
        assert!(result.is_err());
    }

    #[test]
    fn another_copy_during_retry_cancels_restoration() {
        let sequence = std::cell::Cell::new(7);
        let mut writes = 0;
        let result: Result<Option<()>, String> = retry_clipboard_with(
            || {
                if_clipboard_unchanged(Some(7), sequence.get(), || {
                    writes += 1;
                    Err(windows::core::Error::from_hresult(CLIPBRD_E_CANT_OPEN))
                })
            },
            || {
                sequence.set(8);
                true
            },
        );
        assert_eq!(result, Ok(None));
        assert_eq!(writes, 1);
    }

    #[test]
    fn windows_line_endings_do_not_change_text_identity() {
        assert!(same_text(
            &HSTRING::from("первая\r\nвторая"),
            "первая\nвторая"
        ));
        assert!(!same_text(
            &HSTRING::from("первая\nвторая"),
            "первая вторая"
        ));
    }

    #[test]
    fn nested_waits_share_the_operation_deadline() {
        DEADLINE.with(|value| value.set(Some(Instant::now() - Duration::from_millis(1))));
        assert!(check_deadline().is_err());
        // Another nested check must not allocate a fresh timeout.
        assert!(check_deadline().is_err());
        DEADLINE.with(|value| value.set(None));
    }
}
