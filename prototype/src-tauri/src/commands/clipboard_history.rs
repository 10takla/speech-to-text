use std::time::{Duration, Instant};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use super::scenario_output::RunOutput;
use windows::ApplicationModel::DataTransfer::{
    Clipboard, ClipboardContentOptions, ClipboardHistoryChangedEventArgs, ClipboardHistoryItem,
    ClipboardHistoryItemsResultStatus, DataPackage, DataPackageView, DataProviderHandler,
    StandardDataFormats,
};
use windows::Foundation::{EventHandler, PropertyValue};
use windows::Win32::System::WinRT::{RO_INIT_SINGLETHREADED, RoInitialize, RoUninitialize};
use windows::core::HSTRING;

const CLIPBOARD_RETRY_TIMEOUT: Duration = Duration::from_millis(500);
// Each individual Windows request/history update gets its own budget. There
// is deliberately no deadline shared by the whole copy/paste operation.
const WINDOWS_WAIT_TIMEOUT: Duration = Duration::from_secs(5);
const CLIPBRD_E_CANT_OPEN: windows::core::HRESULT = windows::core::HRESULT(0x800401D0u32 as i32);
static SCENARIO_GENERATION: AtomicU64 = AtomicU64::new(0);
std::thread_local! {
    static RUN_CONTEXT: std::cell::RefCell<Option<Arc<RunOutput>>> = const { std::cell::RefCell::new(None) };
    static OPERATION_GENERATION: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
}

fn check_cancelled() -> Result<(), String> {
    if let Some(context) = RUN_CONTEXT.with(|value| value.borrow().clone()) {
        return if context.cancelled.load(Ordering::Acquire) {
            Err("Операция буфера обмена отменена.".into())
        } else { Ok(()) };
    }
    if OPERATION_GENERATION.with(|value| value.get().is_some_and(|generation|
        generation != SCENARIO_GENERATION.load(Ordering::Acquire))) {
        Err("Операция буфера обмена отменена.".into())
    } else {
        Ok(())
    }
}

// Windows completion callbacks wake the waiting STA thread through this event,
// so readiness is checked when Windows reports progress, not on a timer.
struct Signal(windows_sys::Win32::Foundation::HANDLE);

// An event handle may be set from any thread.
unsafe impl Send for Signal {}
unsafe impl Sync for Signal {}

impl Signal {
    fn new() -> Result<Arc<Self>, String> {
        let handle = unsafe {
            windows_sys::Win32::System::Threading::CreateEventW(std::ptr::null(), 0, 0, std::ptr::null())
        };
        if handle.is_null() {
            return Err("Windows не создала событие ожидания буфера обмена.".into());
        }
        Ok(Arc::new(Self(handle)))
    }

    fn set(&self) {
        unsafe { windows_sys::Win32::System::Threading::SetEvent(self.0) };
    }
}

impl Drop for Signal {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

// Only bounds how soon a scenario cancellation is noticed; completion itself
// wakes the wait through its Signal or a window message.
const CANCEL_CHECK_INTERVAL: Duration = Duration::from_millis(50);

fn wait_for_wake(signal: Option<&Signal>, timeout: Duration) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MsgWaitForMultipleObjects, QS_ALLINPUT};
    let handles = signal.map(|signal| [signal.0]);
    let (count, pointer) = match &handles {
        Some(handles) => (1, handles.as_ptr()),
        None => (0, std::ptr::null()),
    };
    let milliseconds = timeout.as_millis().clamp(1, u32::MAX as u128) as u32;
    unsafe { MsgWaitForMultipleObjects(count, pointer, 0, milliseconds, QS_ALLINPUT) };
}

fn wait_for_condition(
    stage: &str,
    timeout: Duration,
    signal: Option<&Signal>,
    mut ready: impl FnMut() -> Result<bool, String>,
) -> Result<(), String> {
    let started = Instant::now();
    loop {
        check_cancelled()?;
        pump_messages();
        if ready()? {
            return Ok(());
        }
        let elapsed = started.elapsed();
        if elapsed >= timeout {
            return Err(format!("Windows не завершила этап «{stage}» за {} с.", timeout.as_secs()));
        }
        wait_for_wake(signal, (timeout - elapsed).min(CANCEL_CHECK_INTERVAL));
    }
}

// WinRT clipboard operations run in STA. Pump its messages while waiting,
// rather than blocking the apartment with IAsyncOperation::join().
macro_rules! await_winrt {
    ($operation:expr) => {{
        check_cancelled()?;
        let operation = $operation.map_err(|error| error.to_string())?;
        let completed = Signal::new()?;
        let notify = completed.clone();
        operation
            .SetCompleted(&windows_future::AsyncOperationCompletedHandler::new(move |_, _| {
                notify.set();
                Ok(())
            }))
            .map_err(|error| error.to_string())?;
        if let Err(error) = wait_for_condition("чтение данных буфера", WINDOWS_WAIT_TIMEOUT, Some(&completed), || {
            Ok(operation.Status().map_err(|error| error.to_string())?.0 != 0)
        }) {
            let _ = operation.Cancel();
            return Err(error);
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
        if Instant::now() >= until {
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

fn require_clipboard_write(accepted: bool) -> windows::core::Result<()> {
    if accepted {
        Ok(())
    } else {
        // SetContentWithOptions also reports contention by returning false, not
        // just by throwing CLIPBRD_E_CANT_OPEN. Feed both into the bounded retry.
        // https://learn.microsoft.com/uwp/api/windows.applicationmodel.datatransfer.clipboard.setcontentwithoptions
        Err(windows::core::Error::new(
            CLIPBRD_E_CANT_OPEN,
            "Буфер обмена временно занят другим приложением.",
        ))
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
pub(super) struct RecordingClipboard {
    sequence: Option<u32>,
    user_copied: bool,
}

impl RecordingClipboard {
    pub(super) fn at_start() -> Self {
        Self { sequence: Some(clipboard_sequence()), user_copied: false }
    }

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

static RECORDING_CLIPBOARD: LazyLock<Arc<Mutex<RecordingClipboard>>> =
    LazyLock::new(|| Arc::new(Mutex::new(RecordingClipboard::default())));

fn current_clipboard() -> Arc<Mutex<RecordingClipboard>> {
    RUN_CONTEXT.with(|value| value.borrow().as_ref().map(|run| run.clipboard.clone()))
        .unwrap_or_else(|| RECORDING_CLIPBOARD.clone())
}

pub fn begin_recording() {
    SCENARIO_GENERATION.fetch_add(1, Ordering::AcqRel);
    if let Ok(mut recording) = RECORDING_CLIPBOARD.lock() {
        *recording = RecordingClipboard { sequence: Some(clipboard_sequence()), user_copied: false };
    }
}

pub fn end_recording() {
    SCENARIO_GENERATION.fetch_add(1, Ordering::AcqRel);
    if let Ok(mut recording) = RECORDING_CLIPBOARD.lock() {
        *recording = RecordingClipboard::default();
    }
}

fn record_own_write(before: u32, after: u32) {
    // A service write is never a manual copy, for any overlapping launch.
    if let Ok(runs) = super::scenario_output::RUNS.lock() {
        for run in runs.values() {
            if let Ok(mut recording) = run.clipboard.lock() { recording.own_write(before, after); }
        }
    }
    if let Ok(mut recording) = RECORDING_CLIPBOARD.lock() {
        recording.own_write(before, after);
    }
}

struct SavedClipboard {
    content: DataPackage,
    empty: bool,
    // Diagnostics only: the text when plain text was the only format.
    text: Option<HSTRING>,
    formats: u32,
}

fn snapshot_clipboard() -> Result<(u32, SavedClipboard), String> {
    loop {
        check_cancelled()?;
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
            return Ok((sequence, SavedClipboard { content, empty: count == 0, text: plain_text, formats: count }));
        }
    }
}

// Only the sequence number lives across operations. Rich clipboard snapshots
// stay on this STA thread and are taken only when a user copy must be preserved.
struct CopyClipboard {
    sequence: u32,
    restore: Option<SavedClipboard>,
    published_text: Option<String>,
}

impl CopyClipboard {
    fn new() -> Result<Self, String> {
        let sequence = clipboard_sequence();
        let preserve = current_clipboard().lock().map_err(|error| error.to_string())?
            .observe(sequence);
        let mut clipboard = Self { sequence, restore: None, published_text: None };
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
                let current_recording = current_clipboard();
                let mut recording = current_recording.lock().map_err(|error| error.to_string())?;
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
            current_clipboard().lock().map_err(|error| error.to_string())?.observe(sequence);
            self.sequence = sequence;
            self.restore = Some(saved);
        }
        Ok(())
    }

    fn publish(&mut self, content: &DataPackage, history: bool) -> Result<(), String> {
        self.published_text = None;
        loop {
            check_cancelled()?;
            self.observe()?;
            if let Some(sequence) = publish_if_unchanged(content, history, Some(self.sequence))? {
                self.sequence = sequence;
                return Ok(());
            }
        }
    }

    fn write_text(&mut self, text: &str, history: bool) -> Result<(), String> {
        self.publish(&text_content(text)?, history)?;
        self.published_text = Some(text.to_owned());
        Ok(())
    }

    fn finish(&mut self, text: &str) -> Result<(), String> {
        // A later user copy already is the desired current content. Do not
        // read it back or keep retrying restoration while the user copies.
        let current = clipboard_sequence();
        if current != self.sequence {
            let current_recording = current_clipboard();
                let mut recording = current_recording.lock().map_err(|error| error.to_string())?;
            let external = recording.sequence.is_none() || recording.changed(current);
            recording.observe(current);
            if external {
                return Ok(());
            }
            self.sequence = current;
        }
        // Level 0 (or an empty history) already left this exact text in the
        // clipboard. Avoid another SetContent/Flush and history contention.
        if self.restore.is_none() && self.published_text.as_deref() == Some(text)
            && clipboard_sequence() == self.sequence
        {
            return Ok(());
        }
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
        }
        Ok(())
    }
}

pub fn copy_at_level(text: &str, level: i64, context: Option<Arc<RunOutput>>) -> Result<(), String> {
    let started = Instant::now();
    log::info!(
        "clipboard: start level={level}, text={}", preview(text)
    );
    let result = on_clipboard_thread(context, || {
        let mut clipboard = CopyClipboard::new()?;
        let result = copy_text_at_level(text, level, &mut clipboard);
        // Cancellation must release the queue, but still restore the current
        // clipboard. Cleanup reads retain their individual Windows timeout.
        OPERATION_GENERATION.with(|value| value.set(None));
        RUN_CONTEXT.with(|value| *value.borrow_mut() = None);
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
                clipboard.sequence,
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
        wait_for_item(0, "добавление текста", clipboard.sequence, |item| {
            is_plain_text(item, text)
        })?;
        // Recopy from the lower entry upwards to retain the original order.
        for item in saved.iter().rev() {
            clipboard.publish(&item.content, true)?;
            wait_for_item(
                0,
                "восстановление предыдущей записи",
                clipboard.sequence,
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
            clipboard.sequence,
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

// Who requested the delayed paste text. Only a read by the target window's
// processes proves that Ctrl+V consumed it.
#[derive(Default)]
struct PasteRead {
    target: AtomicBool,
    foreign: AtomicU32,
    // A reader that did not open the clipboard (OLE). It may be the target, but
    // clipboard monitors read this way too, right after publication.
    anonymous: AtomicBool,
}

// The text is rendered only when a reader requests it, which is the
// deterministic "Ctrl+V has read the clipboard" signal. No Flush: it would
// render the text immediately and lose that signal.
fn delayed_text_content(
    text: &str,
    readers: Vec<u32>,
    read: Arc<PasteRead>,
    signal: Arc<Signal>,
) -> Result<DataPackage, String> {
    let content = DataPackage::new().map_err(|error| error.to_string())?;
    let value = HSTRING::from(text);
    content
        .SetDataProvider(
            &StandardDataFormats::Text().map_err(|error| error.to_string())?,
            &DataProviderHandler::new(move |request| {
                use windows_sys::Win32::System::DataExchange::GetOpenClipboardWindow;
                use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
                let owner = unsafe { GetOpenClipboardWindow() };
                let mut process = 0;
                if !owner.is_null() {
                    unsafe { GetWindowThreadProcessId(owner, &mut process) };
                }
                // OLE readers do not open the clipboard; they cannot be told apart,
                // so only a read by the target's own process proves Ctrl+V.
                let target = process != 0 && readers.contains(&process);
                log::info!("paste: text requested by {}, counted as target={target}, sequence={}",
                    process_name(process), clipboard_sequence());
                if target {
                    read.target.store(true, Ordering::Release);
                } else if process == 0 {
                    read.anonymous.store(true, Ordering::Release);
                } else {
                    read.foreign.store(process, Ordering::Release);
                }
                let result = request.ok()?.SetData(&PropertyValue::CreateString(&value)?);
                signal.set();
                result
            }),
        )
        .map_err(|error| error.to_string())?;
    Ok(content)
}

pub fn with_text_for_paste(
    text: &str,
    context: Option<Arc<RunOutput>>,
    readers: Vec<u32>,
    paste: impl FnOnce() -> Result<(), String> + Send,
) -> Result<(), String> {
    let started = Instant::now();
    log::info!("paste: start text={}, target processes={}", preview(text),
        readers.iter().map(|&process| process_name(process)).collect::<Vec<_>>().join(", "));
    let result = on_clipboard_thread(context, || {
        let read = Arc::new(PasteRead::default());
        let signal = Signal::new()?;
        let content = delayed_text_content(text, readers, read.clone(), signal.clone())?;
        let (mut sequence, saved) = loop {
            check_cancelled()?;
            // Retry the snapshot if a user copy arrives before publication.
            let (before, saved) = snapshot_clipboard()?;
            log::info!("paste: snapshot done after {} ms, sequence={before}, clipboard before={}",
                started.elapsed().as_millis(), saved_preview(&saved));
            if let Some(sequence) = set_content_if_unchanged(&content, false, Some(before))? {
                if clipboard_sequence() == sequence {
                    log::info!("paste: temporary text published, sequence={sequence}");
                    break (sequence, saved);
                }
                log::warn!("paste: clipboard changed right after publication ({sequence} -> {}), retrying", clipboard_sequence());
            } else {
                log::warn!("paste: clipboard changed before publication, retrying");
            }
        };
        let mut result = check_cancelled().and_then(|_| paste());
        log::info!("paste: input sent after {} ms", started.elapsed().as_millis());
        if result.is_ok() {
            match wait_for_paste_read(&read, &signal, sequence) {
                Ok(current) => {
                    log::info!("paste: text read after {} ms", started.elapsed().as_millis());
                    sequence = current;
                }
                Err(error) => result = Err(error),
            }
        } else {
            // Partial input may still deliver Ctrl+V; nothing will report a read.
            wait_for_paste_reader(sequence);
        }
        // A copy made by the user or another app during paste takes precedence.
        let current = clipboard_sequence();
        if current != sequence {
            log::warn!("paste: clipboard changed during paste ({sequence} -> {current}); not restoring");
        } else {
            log::info!("paste: restoring clipboard to {} after {} ms", saved_preview(&saved), started.elapsed().as_millis());
        }
        if current == sequence {
            let restore = if saved.empty {
                clear_if_unchanged(sequence).map(|_| ())
            } else {
                publish_if_unchanged(&saved.content, false, Some(sequence)).map(|_| ())
            };
            if let Err(error) = restore {
                log::warn!("Не удалось восстановить буфер после вставки: {error}");
                // The delayed text must not outlive this STA thread unrendered.
                if clipboard_sequence() == sequence {
                    let _ = Clipboard::Flush();
                }
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

// Waits until the target application requests the delayed text. Returns the
// clipboard sequence after rendering, which restoration must still match.
fn wait_for_paste_read(read: &PasteRead, signal: &Signal, sequence: u32) -> Result<u32, String> {
    let mut user_copied = false;
    wait_for_condition("чтение вставляемого текста приложением", WINDOWS_WAIT_TIMEOUT, Some(signal), || {
        if read.target.load(Ordering::Acquire) || read.foreign.load(Ordering::Acquire) != 0
            || read.anonymous.load(Ordering::Acquire) {
            return Ok(true);
        }
        // A new copy replaced the text before anyone read it: nothing to restore.
        user_copied = clipboard_sequence() != sequence;
        Ok(user_copied)
    })?;
    if user_copied {
        return Ok(sequence);
    }
    if !read.target.load(Ordering::Acquire) {
        // Another process (a clipboard manager, or an unidentified OLE reader)
        // rendered the text first, so the target's own read can no longer be
        // observed. It usually reads right after publication, before Ctrl+V is
        // even processed, so restoring now would paste the old content.
        let foreign = read.foreign.load(Ordering::Acquire);
        log::warn!("paste: text first read by {}; target read not observable, waiting {} ms before restoring",
            if foreign != 0 { process_name(foreign) } else { process_name(0) }, FOREIGN_READER_GRACE.as_millis());
        wait_for_paste_reader_for(clipboard_sequence(), FOREIGN_READER_GRACE);
    }
    // Rendering may advance the sequence; that write is ours, not a user copy.
    let current = clipboard_sequence();
    if current != sequence {
        record_own_write(sequence, current);
    }
    Ok(current)
}

// Fallback when the target's read cannot be observed: wait a short fixed time
// (or until another copy arrives).
const PASTE_READER_GRACE: Duration = Duration::from_millis(150);
const FOREIGN_READER_GRACE: Duration = Duration::from_millis(500);

fn wait_for_paste_reader(sequence: u32) {
    wait_for_paste_reader_for(sequence, PASTE_READER_GRACE);
}

fn wait_for_paste_reader_for(sequence: u32, grace: Duration) {
    let until = Instant::now() + grace;
    while Instant::now() < until && clipboard_sequence() == sequence {
        pump_messages();
        std::thread::sleep(Duration::from_millis(5));
    }
}

// Short, single-line excerpt for diagnostics: enough to tell texts apart.
pub(super) fn preview(text: &str) -> String {
    let flat: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let count = flat.chars().count();
    if count <= 60 { format!("«{flat}» ({count})") }
    else { format!("«{}…» ({count})", flat.chars().take(60).collect::<String>()) }
}

fn saved_preview(saved: &SavedClipboard) -> String {
    if saved.empty { "пусто".into() }
    else { saved.text.as_ref().map_or_else(|| format!("не только текст ({} форматов)", saved.formats), |text| preview(&text.to_string_lossy())) }
}

fn process_name(process: u32) -> String {
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW};
    if process == 0 { return "OLE/неизвестно".into(); }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process);
        if handle.is_null() { return format!("pid {process}"); }
        let mut buffer = [0u16; 260];
        let mut size = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size) != 0;
        windows_sys::Win32::Foundation::CloseHandle(handle);
        let path = if ok { String::from_utf16_lossy(&buffer[..size as usize]) } else { String::new() };
        let name = path.rsplit('\\').next().unwrap_or_default();
        format!("{} (pid {process})", if name.is_empty() { "?" } else { name })
    }
}

fn clipboard_sequence() -> u32 {
    unsafe { windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber() }
}

fn on_clipboard_thread(
    context: Option<Arc<RunOutput>>,
    operation: impl FnOnce() -> Result<(), String> + Send,
) -> Result<(), String> {
    let generation = SCENARIO_GENERATION.load(Ordering::Acquire);
    // Clipboard WinRT classes require STA; pooled worker threads may already use MTA.
    std::thread::scope(|scope| {
        scope
            .spawn(|| {
                RUN_CONTEXT.with(|value| *value.borrow_mut() = context.clone());
                OPERATION_GENERATION.with(|value| value.set(Some(generation)));
                // Serialize copy and paste without charging queue time to an
                // operation-wide deadline. History processing may take longer.
                let _operation = lock_operation(&CLIPBOARD_OPERATION, check_cancelled)?;
                let _apartment = Apartment::initialize()?;
                operation()
            })
            .join()
            .map_err(|_| "Обработчик буфера обмена завершился с ошибкой.".to_string())?
    })
}

fn lock_operation(
    mutex: &std::sync::Mutex<()>,
    cancelled: impl Fn() -> Result<(), String>,
) -> Result<std::sync::MutexGuard<'_, ()>, String> {
    loop {
        cancelled()?;
        match mutex.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(std::sync::TryLockError::WouldBlock) => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(error) => return Err(error.to_string()),
        }
    }
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

fn set_content_if_unchanged(
    content: &DataPackage,
    include_in_history: bool,
    expected_sequence: Option<u32>,
) -> Result<Option<u32>, String> {
    let options = ClipboardContentOptions::new().map_err(|error| error.to_string())?;
    options
        .SetIsAllowedInHistory(include_in_history)
        .map_err(|error| error.to_string())?;
    if !include_in_history {
        // Temporary service content must not reach other devices either.
        options.SetIsRoamable(false).map_err(|error| error.to_string())?;
    }
    retry_clipboard(|| {
        let before = clipboard_sequence();
        if_clipboard_unchanged(expected_sequence, before, || {
            require_clipboard_write(Clipboard::SetContentWithOptions(content, &options)?)?;
            let sequence = clipboard_sequence();
            record_own_write(before, sequence);
            Ok(sequence)
        })
    })
}

fn publish_if_unchanged(
    content: &DataPackage,
    include_in_history: bool,
    expected_sequence: Option<u32>,
) -> Result<Option<u32>, String> {
    let started = Instant::now();
    let sequence = match set_content_if_unchanged(content, include_in_history, expected_sequence)? {
        None => return Ok(None), // Another copy took precedence while waiting for access.
        Some(sequence) => sequence,
    };
    let set_ms = started.elapsed().as_millis();
    let flushed = retry_clipboard(|| {
        if_clipboard_unchanged(Some(sequence), clipboard_sequence(), || {
            Clipboard::Flush()?;
            let after = clipboard_sequence();
            record_own_write(sequence, after);
            Ok(after)
        })
    })?;
    log::info!(
        "clipboard: publish history={include_in_history} set={set_ms} ms, flush={} ms",
        started.elapsed().as_millis() - set_ms
    );
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
    expected_sequence: u32,
    matches: impl Fn(&ClipboardHistoryItem) -> Result<bool, String>,
) -> Result<(), String> {
    let started = Instant::now();
    log::info!("clipboard: waiting stage={stage}, index={index}");
    // Re-read history when Windows reports a change instead of on a timer.
    // The first check below runs after subscribing, so no update is missed.
    let changed = Signal::new()?;
    let notify = changed.clone();
    let subscription = Clipboard::HistoryChanged(
        &EventHandler::<ClipboardHistoryChangedEventArgs>::new(move |_, _| {
            notify.set();
            Ok(())
        }),
    )
    .map(HistorySubscription)
    .map_err(|error| log::warn!("clipboard: HistoryChanged subscription failed: {error}"))
    .ok();
    let result = wait_for_condition(stage, WINDOWS_WAIT_TIMEOUT, Some(&changed), || {
        if clipboard_sequence() != expected_sequence {
            return Err("Буфер изменён другим копированием. Расстановка истории прервана.".into());
        }
        // Even an already completed WinRT read needs a pumped STA: clipboard
        // history can request delayed content from this publishing thread.
        pump_messages();
        if let Some(item) = history()?.get(index) {
            if matches(item)? {
                log::info!(
                    "clipboard: stage={stage}, index={index}, elapsed_ms={}",
                    started.elapsed().as_millis()
                );
                return Ok(true);
            }
        }
        Ok(false)
    });
    drop(subscription);
    if let Err(error) = &result {
        log::warn!("clipboard: stage={stage}, index={index}, elapsed_ms={}, error={error}", started.elapsed().as_millis());
    }
    result
}

struct HistorySubscription(i64);

impl Drop for HistorySubscription {
    fn drop(&mut self) {
        let _ = Clipboard::RemoveHistoryChanged(self.0);
    }
}

// How long the selection's owner may take to answer the copy command (Office
// and browsers can be slow with large selections).
const SELECTION_COPY_TIMEOUT: Duration = Duration::from_millis(1500);
// Several formats are written one after another; read once the clipboard rests.
const SELECTION_SETTLE: Duration = Duration::from_millis(30);

// Reads the text selected in another application by asking it to copy, and puts
// the previous clipboard content back. `send_copy` sends the copy shortcut.
// None: the application copied nothing, i.e. there is no selection.
pub(super) fn copy_selection(
    context: Option<Arc<RunOutput>>,
    send_copy: impl FnOnce() -> Result<(), String> + Send,
) -> Result<Option<String>, String> {
    let started = Instant::now();
    let found = Mutex::new(None::<String>);
    let result = on_clipboard_thread(context, || {
        let (before, saved) = snapshot_clipboard()?;
        let outcome = (|| -> Result<(), String> {
            send_copy()?;
            let waited = Instant::now();
            while clipboard_sequence() == before {
                check_cancelled()?;
                if waited.elapsed() >= SELECTION_COPY_TIMEOUT { return Ok(()); }
                pump_messages();
                std::thread::sleep(Duration::from_millis(5));
            }
            // Wait until the owner has finished writing all of its formats.
            let mut last = clipboard_sequence();
            let settle_deadline = Instant::now() + SELECTION_COPY_TIMEOUT;
            loop {
                pump_messages();
                std::thread::sleep(SELECTION_SETTLE);
                let current = clipboard_sequence();
                if current == last || Instant::now() >= settle_deadline { break; }
                last = current;
            }
            let view = retry_clipboard(Clipboard::GetContent)?;
            let has_text = view
                .Contains(&StandardDataFormats::Text().map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())?;
            if has_text {
                let text = await_winrt!(view.GetTextAsync())?;
                *found.lock().map_err(|error| error.to_string())? = Some(text.to_string_lossy());
            }
            Ok(())
        })();
        // The target's copy is not a manual copy by the user; put the old content back
        // unless somebody copied something else in the meantime.
        let current = clipboard_sequence();
        if current != before {
            record_own_write(before, current);
            let restored = if saved.empty {
                clear_if_unchanged(current).map(|_| ())
            } else {
                publish_if_unchanged(&saved.content, false, Some(current)).map(|_| ())
            };
            if let Err(error) = restored {
                log::warn!("Не удалось восстановить буфер после чтения выделения: {error}");
                if outcome.is_ok() { return Err(format!("Выделение прочитано, но не удалось восстановить буфер: {error}")); }
            }
        }
        outcome
    });
    log::info!("selection: clipboard copy took {} ms, success={}", started.elapsed().as_millis(), result.is_ok());
    result?;
    Ok(found.into_inner().map_err(|error| error.to_string())?)
}

#[cfg(test)]
mod tests {
    #[test]
    fn overlapping_runs_keep_independent_cancellation_and_manual_copy_tracking() {
        use super::*;
        use super::super::scenario_output::{begin_scenario_output, cancel_scenario_output, finish_scenario_output, context};
        begin_scenario_output("parallel-a".into()).unwrap();
        begin_scenario_output("parallel-b".into()).unwrap();
        let first = context(Some("parallel-a")).unwrap().unwrap();
        let second = context(Some("parallel-b")).unwrap().unwrap();
        *first.clipboard.lock().unwrap() = RecordingClipboard { sequence: Some(7), user_copied: false };
        *second.clipboard.lock().unwrap() = RecordingClipboard { sequence: Some(7), user_copied: false };
        record_own_write(7, 8);
        assert!(!first.clipboard.lock().unwrap().user_copied);
        assert!(!second.clipboard.lock().unwrap().user_copied);
        cancel_scenario_output("parallel-b".into()).unwrap();
        RUN_CONTEXT.with(|value| *value.borrow_mut() = Some(first.clone()));
        assert!(check_cancelled().is_ok());
        RUN_CONTEXT.with(|value| *value.borrow_mut() = Some(second.clone()));
        assert!(check_cancelled().is_err());
        RUN_CONTEXT.with(|value| *value.borrow_mut() = None);
        finish_scenario_output("parallel-b".into()).unwrap();
        assert!(context(Some("parallel-b")).is_err());
        assert!(context(Some("parallel-a")).is_ok());
        finish_scenario_output("parallel-a".into()).unwrap();
    }
    use super::*;

    #[test]
    fn missing_history_position_releases_the_next_operation() {
        let mutex = std::sync::Mutex::new(());
        {
            let _operation = lock_operation(&mutex, || Ok(())).unwrap();
            let error = wait_for_condition("проверка позиции текста", Duration::ZERO, None, || Ok(false))
                .unwrap_err();
            assert!(error.contains("проверка позиции текста"));
        }
        assert!(mutex.try_lock().is_ok());
    }

    #[test]
    fn a_failed_stage_does_not_expire_later_stages_or_cleanup() {
        assert!(wait_for_condition("первый этап", Duration::ZERO, None, || Ok(false)).is_err());
        let mut reads = 0;
        assert!(wait_for_condition("следующий этап", Duration::from_secs(1), None, || {
            reads += 1;
            Ok(reads == 2)
        }).is_ok());
        assert_eq!(reads, 2);
    }

    #[test]
    fn queued_operation_can_be_cancelled_without_waiting_for_the_owner() {
        let mutex = std::sync::Mutex::new(());
        let _owner = mutex.lock().unwrap();
        let checks = std::cell::Cell::new(0);
        let error = lock_operation(&mutex, || {
            checks.set(checks.get() + 1);
            if checks.get() == 2 { Err("отмена".into()) } else { Ok(()) }
        }).unwrap_err();
        assert_eq!(error, "отмена");
        assert_eq!(checks.get(), 2);
    }

    #[test]
    fn cancellation_interrupts_a_pending_windows_wait() {
        let result = wait_for_condition("чтение данных буфера", Duration::from_secs(5), None, || {
            OPERATION_GENERATION.with(|value| value.set(Some(
                SCENARIO_GENERATION.load(Ordering::Acquire).wrapping_sub(1)
            )));
            Ok(false)
        });
        OPERATION_GENERATION.with(|value| value.set(None));
        assert!(result.unwrap_err().contains("отменена"));
        // Cleanup can still proceed after cancellation.
        assert!(wait_for_condition("восстановление", Duration::ZERO, None, || Ok(true)).is_ok());
    }

    #[test]
    fn windows_errors_are_returned_without_waiting_for_a_timeout() {
        let result = wait_for_condition("чтение", Duration::from_secs(5), None, || Err("ошибка Windows".into()));
        assert_eq!(result.unwrap_err(), "ошибка Windows");
    }

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
    fn retries_false_set_content_results_as_temporary_contention() {
        let mut attempts = 0;
        let mut waits = 0;
        let result = retry_clipboard_with(
            || {
                attempts += 1;
                require_clipboard_write(attempts >= 3)
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
    fn repeated_false_set_content_results_respect_the_retry_budget() {
        let mut attempts = 0;
        let mut waits = 0;
        let result = retry_clipboard_with(
            || {
                attempts += 1;
                require_clipboard_write(false)
            },
            || {
                waits += 1;
                waits < 3
            },
        );
        assert!(result.unwrap_err().contains("временно занят"));
        assert_eq!(attempts, 3);
    }

    #[test]
    fn user_copy_wins_if_set_content_returned_false() {
        let sequence = std::cell::Cell::new(7);
        let mut attempts = 0;
        let result = retry_clipboard_with(
            || if_clipboard_unchanged(Some(7), sequence.get(), || {
                attempts += 1;
                require_clipboard_write(false)
            }),
            || {
                sequence.set(8);
                true
            },
        );
        assert_eq!(result, Ok(None));
        assert_eq!(attempts, 1);
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

}
