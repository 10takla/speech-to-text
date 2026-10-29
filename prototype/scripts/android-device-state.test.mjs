import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adbConnections, createDeviceResolver, savedDeviceConnections } from './android-device-state.mjs';

function simulatedAdb(saved, transports = [], network = {}) {
  const state = { services: '', time: 0 };
  const connected = new Map(transports.map(device => [device.endpoint, device]));
  const calls = [];
  const devices = savedDeviceConnections(saved);
  const resolver = createDeviceResolver({
    savedDevices: devices, log: () => {}, now: () => state.time,
    capture(args) {
      calls.push(args);
      if (args[0] === 'devices') return [...connected.values()].map(device => `${device.endpoint}\t${device.state}\n`).join('');
      if (args[0] === 'mdns') return state.services;
      if (args[0] === '-s') return connected.get(args[1])?.serial ?? '';
      if (args[0] === 'disconnect') { connected.delete(args[1]); return 'disconnected'; }
      if (args[0] === 'connect') {
        const serial = network[args[1]];
        if (!serial) return 'failed to connect';
        connected.set(args[1], { endpoint: args[1], serial, state: 'device' });
        return 'connected';
      }
      throw new Error(`Unexpected ADB command: ${args.join(' ')}`);
    },
  });
  return { state, connected, devices, calls, resolver };
}

test('loads only serials and discards saved addresses', async () => {
  const devices = savedDeviceConnections([{ serial: 'phone-1', wifiEndpoint: '10.0.0.1:5555' }, { serial: 'phone-2' }]);
  assert.deepEqual([...devices.values()], [{ serial: 'phone-1' }, { serial: 'phone-2' }]);
  for (const invalid of [undefined, null, {}, { devices: [] }]) assert.equal(savedDeviceConnections(invalid).size, 0);
});

test('matches serials rather than transport names and does not enroll unknown devices', async () => {
  const fake = simulatedAdb([{ serial: 'phone-1' }], [
    { endpoint: 'different-usb-id', serial: 'phone-1', state: 'device' },
    { endpoint: 'phone-1', serial: 'other-phone', state: 'device' },
  ]);
  assert.deepEqual(await fake.resolver.resolve(), [{ serial: 'phone-1', endpoint: 'different-usb-id' }]);
  assert.deepEqual([...fake.devices.values()], [{ serial: 'phone-1' }]);
});

test('recognizes two allowed devices including an emulator', async () => {
  const fake = simulatedAdb([{ serial: 'phone-1' }, { serial: 'emulator-1' }], [
    { endpoint: 'usb-id', serial: 'phone-1', state: 'device' },
    { endpoint: '127.0.0.1:5555', serial: 'emulator-1', state: 'device' },
  ]);
  assert.deepEqual(await fake.resolver.resolve(), [
    { serial: 'phone-1', endpoint: 'usb-id' }, { serial: 'emulator-1', endpoint: '127.0.0.1:5555' },
  ]);
});

test('tracks changed addresses by serial and prefers USB without duplicates', async () => {
  const fake = simulatedAdb([{ serial: 'phone-1' }]);
  for (const endpoint of ['10.0.0.1:5555', '10.0.0.2:60000', 'usb-id']) {
    fake.connected.clear();
    fake.connected.set(endpoint, { endpoint, serial: 'phone-1', state: 'device' });
    assert.deepEqual(await fake.resolver.resolve(), [{ serial: 'phone-1', endpoint }]);
  }
  fake.connected.set('10.0.0.2:60000', { endpoint: '10.0.0.2:60000', serial: 'phone-1', state: 'device' });
  assert.deepEqual(await fake.resolver.resolve(), [{ serial: 'phone-1', endpoint: 'usb-id' }]);
  assert.deepEqual([...fake.devices.values()], [{ serial: 'phone-1' }]);
});

test('skips missing serials, offline devices and unauthorized devices', async () => {
  const fake = simulatedAdb([{ serial: 'phone-1' }], [
    { endpoint: 'usb-id', serial: '', state: 'device' },
    { endpoint: 'offline-id', serial: 'phone-1', state: 'offline' },
    { endpoint: 'unauthorized-id', serial: 'phone-1', state: 'unauthorized' },
  ]);
  assert.deepEqual(await fake.resolver.resolve(), []);
  assert.deepEqual(fake.calls.filter(args => args[0] === '-s').map(args => args[1]), ['usb-id']);
});

test('discovers fresh Wi-Fi addresses and filters by serial after connecting', async () => {
  const fake = simulatedAdb([{ serial: 'phone-1' }], [], { '10.0.0.2:60000': 'phone-1', '10.0.0.3:5555': 'other-phone' });
  fake.state.services = 'adb-one _adb-tls-connect._tcp. 10.0.0.2:60000\nadb-two _adb-tls-connect._tcp. 10.0.0.3:5555\n';
  assert.deepEqual(await fake.resolver.resolve(), [{ serial: 'phone-1', endpoint: '10.0.0.2:60000' }]);
  assert.deepEqual([...fake.devices.values()], [{ serial: 'phone-1' }]);
});

test('never connects using legacy saved Wi-Fi addresses', async () => {
  const fake = simulatedAdb([{ serial: 'phone-1', wifiEndpoint: '10.0.0.1:5555' }]);
  assert.deepEqual(await fake.resolver.resolve(), []);
  assert.equal(fake.calls.some(args => args[0] === 'connect'), false);
});

test('parses device states with extended information', async () => {
  assert.deepEqual(adbConnections('List of devices attached\nusb-id device product:OnePlus9\n10.0.0.1:5555 offline\nother unauthorized\n'), [
    { endpoint: 'usb-id', state: 'device' }, { endpoint: '10.0.0.1:5555', state: 'offline' }, { endpoint: 'other', state: 'unauthorized' },
  ]);
});

test('identifies devices concurrently and preserves USB preference regardless of completion order', async () => {
  const pending = new Map();
  const resolver = createDeviceResolver({
    savedDevices: savedDeviceConnections([{ serial: 'phone' }, { serial: 'emulator' }]),
    capture(args) {
      if (args[0] === 'devices') return 'usb device\n127.0.0.1:5555 device\n10.0.0.1:5555 device\n';
      return new Promise(resolve => pending.set(args[1], resolve));
    },
  });
  const result = resolver.resolve(false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.size, 3, 'all serial requests start before any finishes');
  pending.get('10.0.0.1:5555')('phone');
  pending.get('127.0.0.1:5555')('emulator');
  pending.get('usb')('phone');
  assert.deepEqual(await result, [
    { serial: 'phone', endpoint: 'usb' }, { serial: 'emulator', endpoint: '127.0.0.1:5555' },
  ]);
});

test('one failed serial request does not discard another device', async () => {
  const resolver = createDeviceResolver({
    savedDevices: savedDeviceConnections([{ serial: 'phone' }]),
    capture: async args => {
      if (args[0] === 'devices') return 'broken device\nusb device\n';
      if (args[1] === 'broken') throw new Error('unavailable');
      return 'phone';
    },
  });
  assert.deepEqual(await resolver.resolve(false), [{ serial: 'phone', endpoint: 'usb' }]);
});
