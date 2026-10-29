import { useEffect, useState } from 'react';
import ControlPanelApp from './ControlPanelApp';
import { androidCall } from './android-runtime';
import { loadSettings } from './config';
import './android.scss';

interface Permissions { overlay: boolean; microphone: boolean }

export default function AndroidApp() {
  const [message, setMessage] = useState('');
  const [permissions, setPermissions] = useState<Permissions | null>(null);
  const refreshPermissions = async () => {
    setPermissions(await androidCall<Permissions>('permissionStatus'));
  };
  useEffect(() => {
    let mounted = true;
    const refresh = () => {
      void androidCall<Permissions>('permissionStatus').then(value => {
        if (mounted) setPermissions(value);
      }).catch(console.warn);
    };
    refresh();
    window.addEventListener('android-permissions-changed', refresh);
    return () => {
      mounted = false;
      window.removeEventListener('android-permissions-changed', refresh);
    };
  }, []);
  useEffect(() => {
    void androidCall('saveBubbleConfiguration', { text: JSON.stringify(loadSettings()) }).catch(console.warn);
    document.body.classList.add('android-app');
    document.documentElement.classList.add('android-root');
    return () => {
      document.body.classList.remove('android-app');
      document.documentElement.classList.remove('android-root');
    };
  }, []);
  const runSetup = async (action: string) => {
    try {
      await androidCall(action);
      await refreshPermissions();
      setMessage('');
    } catch (error) { setMessage(String(error)); }
  };
  return <>
    {permissions && (!permissions.overlay || !permissions.microphone) && <section className="android-record-controls cp-card">
      {!permissions.overlay && <button className="btn secondary" onClick={() => void runSetup('bubbleSettings')}>Включить оверлей</button>}
      {!permissions.microphone && <button className="btn secondary" onClick={() => void runSetup('requestMicrophonePermission')}>Доступ к микрофону</button>}
      {message && <p role="status">{message}</p>}
    </section>}
    <ControlPanelApp />
  </>;
}
