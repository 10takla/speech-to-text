export function isWifiEndpoint(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(?:\[[\da-f:]+\]|[^\s:]+):(\d+)$/i);
  return !!match && Number(match[1]) > 0 && Number(match[1]) <= 65535;
}

export function savedDeviceConnections(saved) {
  const devices = new Map();
  const entries = Array.isArray(saved?.devices) ? saved.devices : [saved];
  for (const entry of entries) {
    let id = typeof entry === 'string' ? entry : entry?.id ?? entry?.serial;
    let wifiEndpoint = typeof entry === 'object' ? entry?.wifiEndpoint ?? entry?.endpoint : undefined;
    // A transport address cannot identify a phone. Discard legacy entries without a real serial.
    if (typeof id !== 'string' || !id.trim() || isWifiEndpoint(id)) continue;
    if (!isWifiEndpoint(wifiEndpoint)) wifiEndpoint = undefined;
    devices.set(id, { id, ...(wifiEndpoint ? { wifiEndpoint } : {}) });
  }
  return devices;
}

export function rememberDeviceConnection(devices, id, endpoint) {
  const previous = devices.get(id);
  const wifiEndpoint = isWifiEndpoint(endpoint) ? endpoint : previous?.wifiEndpoint;
  if (previous && previous.wifiEndpoint === wifiEndpoint) return false;
  devices.set(id, { id, ...(wifiEndpoint ? { wifiEndpoint } : {}) });
  return true;
}

export function adbConnections(output) {
  return output.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^(\S+)\s+(device|offline|unauthorized)(?:\s|$)/);
    return match ? [{ endpoint: match[1], state: match[2] }] : [];
  });
}

const mdnsName = endpoint => endpoint.replace(/\.$/, '').replace(/\._adb-tls-connect\._tcp$/, '');
const isWireless = endpoint => isWifiEndpoint(endpoint) || /\._adb-tls-connect\._tcp\.?$/.test(endpoint);

export function createDeviceResolver({ capture, savedDevices, persist, log = console.log, now = Date.now }) {
  const lastAttempts = new Map();
  const unavailable = new Map();

  function identify(endpoint) {
    const id = capture(['-s', endpoint, 'shell', 'getprop', 'ro.serialno']).trim();
    if (id && !/^(unknown|null|0+)$/i.test(id) && !/\s/.test(id)) return id;
    log(`ADB ${endpoint} не вернул ro.serialno. Установка отложена.`);
    return null;
  }

  function remember(id, endpoint) {
    if (rememberDeviceConnection(savedDevices, id, endpoint)) persist();
  }

  function resolve(discover = true) {
    let connections = adbConnections(capture(['devices']));
    const services = new Map();
    if (discover) {
      for (const line of capture(['mdns', 'services']).split(/\r?\n/)) {
        const match = line.match(/^\s*(\S+)\s+_adb-tls-connect\._tcp\.?\s+(\S+)/);
        if (match && isWifiEndpoint(match[2])) services.set(mdnsName(match[1]), match[2]);
      }
    }
    const addressOf = endpoint => services.get(mdnsName(endpoint)) ?? endpoint;

    function connectedDevices() {
      const devices = new Map();
      const ready = connections.filter(connection => connection.state === 'device');
      ready.sort((a, b) => Number(isWireless(a.endpoint)) - Number(isWireless(b.endpoint)));
      for (const { endpoint } of ready) {
        const id = identify(endpoint);
        if (!id) continue;
        remember(id, addressOf(endpoint));
        if (!devices.has(id)) devices.set(id, { id, endpoint });
      }
      return devices;
    }

    // Recognize existing transports before trying stale saved network addresses.
    let devices = connectedDevices();
    if (discover) {
      const candidates = new Set(services.values());
      const candidateOwners = new Map();
      for (const saved of savedDevices.values()) {
        if (saved.wifiEndpoint && !devices.has(saved.id)) {
          candidates.add(saved.wifiEndpoint);
          candidateOwners.set(saved.wifiEndpoint, saved.id);
        }
      }
      for (const endpoint of candidates) {
        if (devices.has(candidateOwners.get(endpoint))) continue;
        if (connections.some(connection => connection.state === 'unauthorized' && addressOf(connection.endpoint) === endpoint)) continue;
        if ([...devices.values()].some(device => addressOf(device.endpoint) === endpoint)) continue;
        if (lastAttempts.has(endpoint) && now() - lastAttempts.get(endpoint) < 30000) continue;
        lastAttempts.set(endpoint, now());
        // Recreate only the failed wireless transport; leave healthy USB connections intact.
        for (const connection of connections) {
          if (connection.state === 'offline' && isWireless(connection.endpoint) && addressOf(connection.endpoint) === endpoint) {
            capture(['disconnect', connection.endpoint]);
          }
        }
        log(`Подключаю ADB по Wi-Fi: ${endpoint}.`);
        const result = capture(['connect', endpoint]).trim();
        if (result) log(`ADB ${endpoint}: ${result}`);
        connections = adbConnections(capture(['devices']));
        devices = connectedDevices();
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

  return { resolve, identify, remember };
}
