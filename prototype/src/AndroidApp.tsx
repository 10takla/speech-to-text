import { useEffect, useState } from 'react';
import ControlPanelApp from './ControlPanelApp';
import { androidCall } from './android-runtime';
import { loadSettings } from './config';
import './android.scss';

export default function AndroidApp() {
  const [message, setMessage] = useState('');
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
      setMessage('');
    } catch (error) { setMessage(String(error)); }
  };
  return <>
    <section className="android-record-controls cp-card">
      <button className="btn secondary" onClick={() => void runSetup('bubbleSettings')}>Включить оверлей</button>
      <button className="btn secondary" onClick={() => void runSetup('requestMicrophonePermission')}>Доступ к микрофону</button>
      {message && <p role="status">{message}</p>}
    </section>
    <ControlPanelApp />
  </>;
}
