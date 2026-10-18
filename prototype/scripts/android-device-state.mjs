export function isWifiEndpoint(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(?:\[[\da-f:]+\]|[^\s:]+):(\d+)$/i);
  return !!match && Number(match[1]) > 0 && Number(match[1]) <= 65535;
}

export function savedDeviceConnections(saved) {
  const devices = new Map();
  const entries = Array.isArray(saved) ? saved : [];
  for (const entry of entries) {
    const serial = entry?.serial;
    if (typeof serial !== 'string' || !serial.trim() || isWifiEndpoint(serial)) continue;
    devices.set(serial, { serial });
  }
  return devices;
}

export function adbConnections(output) {
  return output.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^(\S+)\s+(device|offline|unauthorized)(?:\s|$)/);
    return match ? [{ endpoint: match[1], state: match[2] }] : [];
  });
}

const mdnsName = endpoint => endpoint.replace(/\.$/, '').replace(/\._adb-tls-connect\._tcp$/, '');
const isWireless = endpoint => isWifiEndpoint(endpoint) || /\._adb-tls-connect\._tcp\.?$/.test(endpoint);

export function createDeviceResolver({ capture, savedDevices, log = console.log, now = Date.now }) {
  const lastAttempts = new Map();
  const unavailable = new Map();

  async function identify(endpoint) {
    const serial = (await capture(['-s', endpoint, 'shell', 'getprop', 'ro.serialno'])).trim();
    if (serial && !/^(unknown|null|0+)$/i.test(serial) && !/\s/.test(serial)) return serial;
    log(`ADB ${endpoint} не вернул ro.serialno. Установка отложена.`);
    return null;
  }

  async function resolve(discover = true) {
    let connections = adbConnections(await capture(['devices']));
    const services = new Map();
    if (discover) {
      for (const line of (await capture(['mdns', 'services'])).split(/\r?\n/)) {
        const match = line.match(/^\s*(\S+)\s+_adb-tls-connect\._tcp\.?\s+(\S+)/);
        if (match && isWifiEndpoint(match[2])) services.set(mdnsName(match[1]), match[2]);
      }
    }
    const addressOf = endpoint => services.get(mdnsName(endpoint)) ?? endpoint;

    async function connectedDevices() {
      const devices = new Map();
      const ready = connections.filter(connection => connection.state === 'device');
      ready.sort((a, b) => Number(isWireless(a.endpoint)) - Number(isWireless(b.endpoint)));
      const identified = await Promise.allSettled(ready.map(async ({ endpoint }) => ({
        serial: await identify(endpoint), endpoint,
      })));
      for (const result of identified) {
        if (result.status === 'rejected') continue;
        const { serial, endpoint } = result.value;
        if (!serial || !savedDevices.has(serial)) continue;
        if (!devices.has(serial)) devices.set(serial, { serial, endpoint });
      }
      return devices;
    }

    // Match current transports against the serial allowlist before installing.
    let devices = await connectedDevices();
    if (discover) {
      const candidates = new Set(services.values());
      const attempts = await Promise.allSettled([...candidates].map(async endpoint => {
        if (connections.some(connection => connection.state === 'unauthorized' && addressOf(connection.endpoint) === endpoint)) return;
        if ([...devices.values()].some(device => addressOf(device.endpoint) === endpoint)) return;
        if (lastAttempts.has(endpoint) && now() - lastAttempts.get(endpoint) < 30000) return;
        lastAttempts.set(endpoint, now());
        for (const connection of connections) {
          if (connection.state === 'offline' && isWireless(connection.endpoint) && addressOf(connection.endpoint) === endpoint) {
            await capture(['disconnect', connection.endpoint]);
          }
        }
        log(`Подключаю ADB по Wi-Fi: ${endpoint}.`);
        const result = (await capture(['connect', endpoint])).trim();
        if (result) log(`ADB ${endpoint}: ${result}`);
        return true;
      }));
      if (attempts.some(attempt => attempt.status === 'fulfilled' && attempt.value)) {
        connections = adbConnections(await capture(['devices']));
        devices = await connectedDevices();
      }
    }

    for (const { endpoint, state } of connections) {
      if (state === 'device') unavailable.delete(endpoint);
      else if (unavailable.get(endpoint) !== state) {
        log(`ADB ${endpoint}: ${state}. APK ожидает рабочего подключения.`);
        unavailable.set(endpoint, state);
      }
    }
    for (const endpoint of unavailable.keys()) {
      if (!connections.some(connection => connection.endpoint === endpoint)) unavailable.delete(endpoint);
    }
    return [...devices.values()];
  }

  return { resolve, identify };
}
