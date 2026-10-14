import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adbConnections, createDeviceResolver, rememberDeviceConnection, savedDeviceConnections } from './android-device-state.mjs';

test('keeps a Wi-Fi address when the same phone returns over USB', () => {
  const devices = savedDeviceConnections({ devices: [{ id: 'phone-1' }] });
  assert.equal(rememberDeviceConnection(devices, 'phone-1', '192.168.0.101:41367'), true);
  assert.equal(rememberDeviceConnection(devices, 'phone-1', 'phone-1'), false);
  assert.deepEqual([...devices.values()], [{ id: 'phone-1', wifiEndpoint: '192.168.0.101:41367' }]);
});

function simulatedAdb(saved, transports = [], network = {}) {
  const state = { services: '', time: 0, writes: 0 };
  const connected = new Map(transports.map(device => [device.endpoint, device]));
  const calls = [];
  const devices = savedDeviceConnections({ devices: saved });
  const resolver = createDeviceResolver({
    savedDevices: devices, persist: () => state.writes++, log: () => {}, now: () => state.time,
    capture(args) {
      calls.push(args);
      if (args[0] === 'devices') return [...connected.values()].map(device => `${device.endpoint}\t${device.state}\n`).join('');
      if (args[0] === 'mdns') return state.services;
      if (args[0] === '-s') return connected.get(args[1])?.id ?? '';
      if (args[0] === 'disconnect') { connected.delete(args[1]); return 'disconnected'; }
      if (args[0] === 'connect') {
        const id = network[args[1]];
        if (!id) return 'failed to connect';
        connected.set(args[1], { endpoint: args[1], id, state: 'device' });
        return 'connected';
      }
      throw new Error(`Unexpected ADB command: ${args.join(' ')}`);
    },
  });
  return { state, connected, devices, calls, resolver };
}

test('recognizes an already connected phone after both IP and port change without reconnecting', () => {
  const fake = simulatedAdb([{ id: 'phone-1', wifiEndpoint: '192.168.0.1:30000' }], [
    { endpoint: '10.8.1.2:41367', state: 'device', id: 'phone-1' },
  ]);
  assert.deepEqual(fake.resolver.resolve(), [{ id: 'phone-1', endpoint: '10.8.1.2:41367' }]);
  assert.equal(fake.devices.get('phone-1').wifiEndpoint, '10.8.1.2:41367');
  assert.equal(fake.calls.some(args => args[0] === 'connect'), false);
});

test('uses USB when USB and Wi-Fi report the same serial and retains the wireless address', () => {
  const fake = simulatedAdb([], [
    { endpoint: '10.8.1.2:41367', state: 'device', id: 'phone-1' },
    { endpoint: 'usb-transport', state: 'device', id: 'phone-1' },
  ]);
  assert.deepEqual(fake.resolver.resolve(), [{ id: 'phone-1', endpoint: 'usb-transport' }]);
  assert.deepEqual([...fake.devices.values()], [{ id: 'phone-1', wifiEndpoint: '10.8.1.2:41367' }]);
});

test('does not try a stale Wi-Fi address when that phone is already recognized over USB', () => {
  const fake = simulatedAdb([{ id: 'phone-1', wifiEndpoint: '192.168.0.1:30000' }], [
    { endpoint: 'different-usb-transport', state: 'device', id: 'phone-1' },
  ]);
  assert.deepEqual(fake.resolver.resolve(), [{ id: 'phone-1', endpoint: 'different-usb-transport' }]);
  assert.equal(fake.calls.some(args => args[0] === 'connect'), false);
});

test('reconnects to a remembered address and verifies the serial after connecting', () => {
  const fake = simulatedAdb([{ id: 'phone-1', wifiEndpoint: '10.8.1.2:41367' }], [], { '10.8.1.2:41367': 'phone-1' });
  assert.deepEqual(fake.resolver.resolve(), [{ id: 'phone-1', endpoint: '10.8.1.2:41367' }]);
  assert.ok(fake.calls.some(args => args.join(' ') === '-s 10.8.1.2:41367 shell getprop ro.serialno'));
});

test('discovers a new IP and port through mDNS and stops trying the previous address', () => {
  const fake = simulatedAdb([{ id: 'phone-1', wifiEndpoint: '192.168.0.1:30000' }], [], { '10.8.1.2:41367': 'phone-1' });
  fake.state.services = 'adb-phone-1-random _adb-tls-connect._tcp. 10.8.1.2:41367\n';
  assert.deepEqual(fake.resolver.resolve(), [{ id: 'phone-1', endpoint: '10.8.1.2:41367' }]);
  assert.equal(fake.devices.get('phone-1').wifiEndpoint, '10.8.1.2:41367');
  assert.deepEqual(fake.calls.filter(args => args[0] === 'connect'), [['connect', '10.8.1.2:41367']]);
});

test('resolves ADB mDNS transport names to an address while retaining the current transport for commands', () => {
  const endpoint = 'adb-phone-1-random._adb-tls-connect._tcp';
  const fake = simulatedAdb([], [{ endpoint, state: 'device', id: 'phone-1' }]);
  fake.state.services = 'adb-phone-1-random _adb-tls-connect._tcp 10.8.1.2:41367\n';
  assert.deepEqual(fake.resolver.resolve(), [{ id: 'phone-1', endpoint }]);
  assert.equal(fake.devices.get('phone-1').wifiEndpoint, '10.8.1.2:41367');
  assert.equal(fake.calls.some(args => args[0] === 'connect'), false);
});

test('recovers an offline wireless transport and throttles failed reconnection attempts', () => {
  const fake = simulatedAdb([{ id: 'phone-1', wifiEndpoint: '10.8.1.2:41367' }], [
    { endpoint: '10.8.1.2:41367', state: 'offline' },
  ]);
  assert.deepEqual(fake.resolver.resolve(), []);
  assert.deepEqual(fake.calls.filter(args => ['connect', 'disconnect'].includes(args[0])), [
    ['disconnect', '10.8.1.2:41367'], ['connect', '10.8.1.2:41367'],
  ]);
  fake.state.time = 10000;
  fake.resolver.resolve();
  assert.equal(fake.calls.filter(args => args[0] === 'connect').length, 1);
  fake.state.time = 30000;
  fake.resolver.resolve();
  assert.equal(fake.calls.filter(args => args[0] === 'connect').length, 2);
});

test('does not treat missing serials or a reused IP as the previously saved phone', () => {
  const fake = simulatedAdb([{ id: 'phone-1', wifiEndpoint: '10.8.1.2:41367' }], [
    { endpoint: 'usb-no-serial', state: 'device', id: '' },
  ], { '10.8.1.2:41367': 'phone-2' });
  assert.deepEqual(fake.resolver.resolve(), [{ id: 'phone-2', endpoint: '10.8.1.2:41367' }]);
  assert.equal(fake.devices.has('usb-no-serial'), false);
});

test('leaves unauthorized transports waiting for user authorization', () => {
  const fake = simulatedAdb([{ id: 'phone-1', wifiEndpoint: '10.8.1.2:41367' }], [
    { endpoint: '10.8.1.2:41367', state: 'unauthorized' },
  ]);
  assert.deepEqual(fake.resolver.resolve(), []);
  assert.equal(fake.calls.some(args => ['connect', 'disconnect', '-s'].includes(args[0])), false);
});

test('tracks one phone through USB, Wi-Fi, changed port, changed IP, and back to USB', () => {
  const fake = simulatedAdb([]);
  for (const endpoint of ['usb-transport', '192.168.0.101:41367', '192.168.0.101:50000', '10.8.1.2:60000', 'usb-transport']) {
    fake.connected.clear();
    fake.connected.set(endpoint, { endpoint, state: 'device', id: 'phone-1' });
    assert.deepEqual(fake.resolver.resolve(), [{ id: 'phone-1', endpoint }]);
    assert.equal(fake.devices.size, 1);
  }
  assert.deepEqual([...fake.devices.values()], [{ id: 'phone-1', wifiEndpoint: '10.8.1.2:60000' }]);
  assert.equal(fake.calls.some(args => args[0] === 'connect'), false);
});

test('updates changing ports without creating another phone', () => {
  const devices = savedDeviceConnections({ devices: [{ id: 'phone-1', wifiEndpoint: '192.168.0.101:41367' }] });
  rememberDeviceConnection(devices, 'phone-1', '192.168.0.101:50000');
  assert.deepEqual([...devices.values()], [{ id: 'phone-1', wifiEndpoint: '192.168.0.101:50000' }]);
});

test('discards legacy address-only identifiers and remembers the real serial after recognition', () => {
  const devices = savedDeviceConnections({ devices: ['192.168.0.101:41367', 'phone-2'] });
  assert.deepEqual([...devices.values()], [{ id: 'phone-2' }]);
  rememberDeviceConnection(devices, 'phone-1', '192.168.0.101:41367');
  assert.equal(devices.size, 2);
  assert.deepEqual(devices.get('phone-1'), { id: 'phone-1', wifiEndpoint: '192.168.0.101:41367' });
  assert.deepEqual([...savedDeviceConnections({ serial: 'old-phone' }).values()], [{ id: 'old-phone' }]);
});

test('does not reconnect an orphaned old port while the phone is already connected on a new port', () => {
  const fake = simulatedAdb([
    { id: 'phone-1', wifiEndpoint: '192.168.0.101:42159' },
    { wifiEndpoint: '192.168.0.101:39755' },
  ], [{ endpoint: '192.168.0.101:42159', state: 'device', id: 'phone-1' }]);
  assert.deepEqual(fake.resolver.resolve(), [{ id: 'phone-1', endpoint: '192.168.0.101:42159' }]);
  assert.equal(fake.calls.some(args => args[0] === 'connect'), false);
  assert.deepEqual([...fake.devices.values()], [{ id: 'phone-1', wifiEndpoint: '192.168.0.101:42159' }]);
});

test('recognizes USB and Wi-Fi transports with tabs and extended device information', () => {
  assert.deepEqual(adbConnections('List of devices attached\nphone-1\tdevice product:OnePlus9\n10.8.1.2:41367 offline\nphone-3 unauthorized\n'), [
    { endpoint: 'phone-1', state: 'device' },
    { endpoint: '10.8.1.2:41367', state: 'offline' },
    { endpoint: 'phone-3', state: 'unauthorized' },
  ]);
});
