import { isTauri, invoke } from '@tauri-apps/api/core';
import { invokeCommand } from './tauri-commands';
import { isAndroid, androidCall } from './android-runtime';

export interface Microphone {
  id: string;
  name: string;
  error: string | null;
}

export async function listMicrophones(): Promise<Microphone[]> {
  if (isAndroid) return androidCall<Microphone[]>('microphones');
  if (isTauri()) return invokeCommand(invoke, 'list_microphones');
  if (!navigator.mediaDevices) throw new Error('Доступ к микрофону недоступен');
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput');
  return [
    { id: '', name: 'Системный микрофон', error: devices.length ? null : 'Нет доступных микрофонов или разрешения' },
    ...devices.filter(device => device.deviceId && device.deviceId !== 'default').map((device, index) => ({
      id: device.deviceId, name: device.label || `Микрофон ${index + 1}`, error: null,
    })),
  ];
}

export async function checkMicrophone(id: string): Promise<void> {
  if (isAndroid) return androidCall('checkMicrophone', { deviceId: id });
  if (isTauri()) return invokeCommand(invoke, 'check_microphone', { deviceId: id || null });
  const stream = await navigator.mediaDevices.getUserMedia({ audio: id ? { deviceId: { exact: id } } : true });
  stream.getTracks().forEach(track => track.stop());
}
