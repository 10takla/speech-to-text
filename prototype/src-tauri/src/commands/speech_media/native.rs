use super::SpeechPlaybackState;
use windows::{
    Foundation::TypedEventHandler,
    Media::{MediaPlaybackStatus, MediaPlaybackType, SystemMediaTransportControls,
        SystemMediaTransportControlsButton, SystemMediaTransportControlsButtonPressedEventArgs},
    Win32::{Foundation::HWND, System::WinRT::ISystemMediaTransportControlsInterop},
};

pub(super) struct Session {
    controls: SystemMediaTransportControls,
    button_token: i64,
}

impl Session {
    pub(super) fn new(hwnd: HWND, title: &str, action: impl Fn(&'static str) + Send + Sync + 'static) -> windows::core::Result<Self> {
        let factory = windows::core::factory::<SystemMediaTransportControls, ISystemMediaTransportControlsInterop>()?;
        let controls: SystemMediaTransportControls = unsafe { factory.GetForWindow(hwnd)? };
        controls.SetIsPlayEnabled(true)?;
        controls.SetIsPauseEnabled(true)?;
        controls.SetIsStopEnabled(true)?;
        let display = controls.DisplayUpdater()?;
        display.SetType(MediaPlaybackType::Music)?;
        display.MusicProperties()?.SetTitle(&title.into())?;
        display.Update()?;
        let button_token = controls.ButtonPressed(&TypedEventHandler::<SystemMediaTransportControls, SystemMediaTransportControlsButtonPressedEventArgs>::new(move |_, args| {
            if let Some(args) = args.as_ref() {
                let name = match args.Button()? {
                    SystemMediaTransportControlsButton::Play => Some("play"),
                    SystemMediaTransportControlsButton::Pause => Some("pause"),
                    SystemMediaTransportControlsButton::Stop => Some("stop"),
                    _ => None,
                };
                if let Some(name) = name { action(name); }
            }
            Ok(())
        }))?;
        Ok(Self { controls, button_token })
    }

    pub(super) fn set_state(&self, state: SpeechPlaybackState) -> windows::core::Result<()> {
        let status = match state {
            SpeechPlaybackState::None => MediaPlaybackStatus::Closed,
            SpeechPlaybackState::Paused => MediaPlaybackStatus::Paused,
            SpeechPlaybackState::Playing => MediaPlaybackStatus::Playing,
        };
        // Natural completion is Paused, so Windows can still send Play. Only
        // clearing the retained audio removes this app from the system controls.
        self.controls.SetPlaybackStatus(status)?;
        self.controls.SetIsEnabled(!matches!(state, SpeechPlaybackState::None))
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.controls.RemoveButtonPressed(self.button_token);
        let _ = self.controls.SetIsEnabled(false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, time::{Duration, Instant}};
    use windows::Media::Control::{GlobalSystemMediaTransportControlsSession, GlobalSystemMediaTransportControlsSessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as SessionStatus};
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    // This exercises Windows' transport service, rather than invoking our event
    // callback directly. It targets only the session created by this test.
    #[test]
    #[ignore = "Creates a temporary Windows media session; run explicitly on a desktop"]
    fn system_play_survives_natural_completion_and_can_pause_again() {
        use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};
        unsafe { RoInitialize(RO_INIT_MULTITHREADED).unwrap(); }
        struct Apartment;
        impl Drop for Apartment { fn drop(&mut self) { unsafe { RoUninitialize(); } } }
        let _apartment = Apartment;
        let title = format!("Speech media regression {}", std::process::id());
        let hwnd = unsafe {
            CreateWindowExW(0, windows_sys::w!("STATIC"), windows_sys::w!("Speech media regression"),
                WS_OVERLAPPEDWINDOW, -32000, -32000, 100, 80,
                std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null())
        };
        assert!(!hwnd.is_null());
        struct TestWindow(windows_sys::Win32::Foundation::HWND);
        impl Drop for TestWindow { fn drop(&mut self) { unsafe { DestroyWindow(self.0); } } }
        let _window = TestWindow(hwnd);
        unsafe { ShowWindow(hwnd, SW_SHOWNOACTIVATE); }
        let (sender, received) = mpsc::channel();
        let controls = Session::new(HWND(hwnd), &title, move |action| { let _ = sender.send(action); }).unwrap();
        controls.set_state(SpeechPlaybackState::Playing).unwrap();
        let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync().unwrap().join().unwrap();
        let find = || -> Option<GlobalSystemMediaTransportControlsSession> {
            let sessions = manager.GetSessions().unwrap();
            (0..sessions.Size().unwrap()).filter_map(|i| sessions.GetAt(i).ok()).find(|session| {
                session.TryGetMediaPropertiesAsync().and_then(|op| op.join()).and_then(|p| p.Title()).is_ok_and(|value| value.to_string() == title)
            })
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        let session = loop {
            pump();
            if let Some(session) = find() { break session; }
            assert!(Instant::now() < deadline, "Test media session was not published in Windows");
            std::thread::sleep(Duration::from_millis(50));
        };
        // The audio element reaches its end, but remains available in the overlay.
        controls.set_state(SpeechPlaybackState::Paused).unwrap();
        wait_status(&session, SessionStatus::Paused);
        assert!(session.TryTogglePlayPauseAsync().unwrap().join().unwrap());
        assert_eq!(wait_action(&received), "play");
        controls.set_state(SpeechPlaybackState::Playing).unwrap();
        wait_status(&session, SessionStatus::Playing);
        assert!(session.TryTogglePlayPauseAsync().unwrap().join().unwrap());
        assert_eq!(wait_action(&received), "pause");
        controls.set_state(SpeechPlaybackState::Paused).unwrap();
        wait_status(&session, SessionStatus::Paused);
        assert!(session.TryPlayAsync().unwrap().join().unwrap());
        assert_eq!(wait_action(&received), "play");
        controls.set_state(SpeechPlaybackState::None).unwrap();
        assert!(!controls.controls.IsEnabled().unwrap());
    }

    fn pump() {
        let mut message = MSG::default();
        unsafe {
            while PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
    }

    fn wait_action(received: &mpsc::Receiver<&'static str>) -> &'static str {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            pump();
            if let Ok(action) = received.try_recv() { return action; }
            assert!(Instant::now() < deadline, "Windows did not deliver the media button event");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn wait_status(session: &GlobalSystemMediaTransportControlsSession, status: SessionStatus) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            pump();
            if session.GetPlaybackInfo().unwrap().PlaybackStatus().unwrap() == status { return; }
            assert!(Instant::now() < deadline, "Windows did not update the media session state");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
