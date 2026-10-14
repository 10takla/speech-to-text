use std::time::{Duration, Instant};
use windows::ApplicationModel::DataTransfer::{
    Clipboard, ClipboardContentOptions, ClipboardHistoryItem, ClipboardHistoryItemsResultStatus,
    DataPackage, DataPackageView, StandardDataFormats,
};
use windows::Win32::System::WinRT::{RO_INIT_SINGLETHREADED, RoInitialize, RoUninitialize};
use windows::core::HSTRING;

// WinRT clipboard operations run in STA. Pump its messages while waiting,
// rather than blocking the apartment with IAsyncOperation::join().
macro_rules! await_winrt {
    ($operation:expr) => {{
        let operation = $operation.map_err(|error| error.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(3);
        while operation.Status().map_err(|error| error.to_string())?.0 == 0 {
            if Instant::now() >= deadline {
                let _ = operation.Cancel();
                return Err("Windows не ответила на запрос к буферу обмена.".into());
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
    content: DataPackage,
}

static CLIPBOARD_OPERATION: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn copy_at_level(text: &str, level: i64) -> Result<(), String> {
    on_clipboard_thread(|| copy_text_at_level(text, level))
}

fn copy_text_at_level(text: &str, level: i64) -> Result<(), String> {
    // Windows keeps up to 25 history entries; reserve one slot for the new text.
    let depth = level.unsigned_abs().min(24) as usize;
    if depth == 0 {
        write_text(text, true)?;
        if Clipboard::IsHistoryEnabled().map_err(|error| error.to_string())? {
            wait_for_item(0, |item| is_plain_text(item, text))?;
        }
        return Ok(());
    }

    // Capture the entries that must stay above the new text, including their formats.
    // Skip a previous copy of this text so that it cannot occupy two levels.
    let mut saved = Vec::new();
    for item in history()? {
        if item_text(&item)?
            .as_ref()
            .is_some_and(|value| value == text)
        {
            continue;
        }
        saved.push(save_item(&item)?);
        if saved.len() == depth {
            break;
        }
    }

    write_text(text, true)?;
    wait_for_item(0, |item| is_plain_text(item, text))?;

    let result = (|| {
        // Recopy from the lower entry upwards to retain the original order.
        for item in saved.iter().rev() {
            publish(&item.content, true)?;
            wait_for_item(0, |current| {
                Ok(current.Id().map_err(|error| error.to_string())? == item.id
                    || (item.text.is_some()
                        && item_text(current)? == item.text
                        && item_html(current)? == item.html))
            })?;
        }
        wait_for_item(saved.len(), |item| is_plain_text(item, text))
    })();

    // Keep normal Ctrl+V usable without promoting the text in the history again.
    let restore = write_text(text, false);
    result.and(restore)
}

pub fn write_text_for_paste(text: &str) -> Result<(), String> {
    on_clipboard_thread(|| write_text(text, false))
}

fn on_clipboard_thread(
    operation: impl FnOnce() -> Result<(), String> + Send,
) -> Result<(), String> {
    // Clipboard WinRT classes require STA; pooled worker threads may already use MTA.
    std::thread::scope(|scope| {
        scope
            .spawn(|| {
                let _operation = CLIPBOARD_OPERATION
                    .lock()
                    .map_err(|error| error.to_string())?;
                let _apartment = Apartment::initialize()?;
                operation()
            })
            .join()
            .map_err(|_| "Обработчик буфера обмена завершился с ошибкой.".to_string())?
    })
}

fn write_text(text: &str, include_in_history: bool) -> Result<(), String> {
    let content = DataPackage::new().map_err(|error| error.to_string())?;
    content
        .SetText(&HSTRING::from(text))
        .map_err(|error| error.to_string())?;
    publish(&content, include_in_history)
}

fn publish(content: &DataPackage, include_in_history: bool) -> Result<(), String> {
    let options = ClipboardContentOptions::new().map_err(|error| error.to_string())?;
    options
        .SetIsAllowedInHistory(include_in_history)
        .map_err(|error| error.to_string())?;
    if !Clipboard::SetContentWithOptions(content, &options).map_err(|error| error.to_string())? {
        return Err("Windows не разрешила изменить буфер обмена.".into());
    }
    Clipboard::Flush().map_err(|error| error.to_string())
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
    Ok(item_text(item)?.as_ref().is_some_and(|value| value == text) && item_html(item)?.is_none())
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
    matches: impl Fn(&ClipboardHistoryItem) -> Result<bool, String>,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(item) = history()?.get(index) {
            if matches(item)? {
                return Ok(());
            }
        }
        if Instant::now() >= deadline {
            return Err("Windows не обновила историю буфера обмена. Проверьте, что история включена и текст не превышает её ограничения.".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}
