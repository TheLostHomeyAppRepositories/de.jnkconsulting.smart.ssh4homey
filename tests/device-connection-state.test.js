const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

let executeCommand;
let testConnection;

class MockSSHApi {
  executeCommand(command) {
    return executeCommand(command);
  }

  connectionTest() {
    return testConnection();
  }
}

function loadDeviceClass() {
  const originalLoad = Module._load;
  Module._load = function mockLoad(request, parent, isMain) {
    if (request === 'homey') {
      return { Device: class MockHomeyDevice {} };
    }
    if (request === '../../src/api/api') {
      return { SSHApi: MockSSHApi };
    }
    if (request === '../../src/model/ServerConfig') {
      return {
        AuthenticationType: {
          USERNAME_PASSWORD: 'username-password',
          PRIVATE_KEY: 'private-key'
        }
      };
    }
    if (request === '../../src/homey/utils') {
      return { updateCapability: async () => {} };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    const devicePath = path.resolve(__dirname, '../.homeybuild/drivers/ssh-server/device.js');
    delete require.cache[devicePath];
    return require(devicePath);
  } finally {
    Module._load = originalLoad;
  }
}

function createListeners(DeviceClass) {
  const listeners = {};
  const device = Object.create(DeviceClass.prototype);
  device.log = () => {};
  device.error = () => {};
  device.startHealthCheck = () => {};
  device.homey = {
    __: (key) => key,
    flow: {
      getActionCard: (id) => ({
        registerRunListener: (listener) => {
          listeners[id] = listener;
        }
      }),
      getDeviceTriggerCard: () => ({ trigger: async () => {} }),
      getTriggerCard: () => ({ trigger: async () => {} })
    }
  };

  DeviceClass.listenersRegistered = false;
  return device.onInit().then(() => listeners);
}

function createTarget() {
  const connectionUpdates = [];
  return {
    connectionUpdates,
    device: {
      loadConfig: () => ({}),
      log: () => {},
      error: () => {},
      homey: { __: (key) => key },
      updateConnectionRelatedCapabilities: async (success) => {
        connectionUpdates.push(success);
      },
      triggerGlobalError: () => {},
      normalizeErrorMessage: (error) => error.message,
      asyncResponseErrorTriggerCard: { trigger: async () => {} },
      asyncResponseTriggerCard: { trigger: async () => {} }
    }
  };
}

async function settleAsyncListener() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('a non-zero sync command exit still records a successful SSH connection', async () => {
  const DeviceClass = loadDeviceClass();
  const listeners = await createListeners(DeviceClass);
  const target = createTarget();
  executeCommand = async () => ({ stdout: '', stderr: 'failed', code: 1, signal: null });

  await assert.rejects(
    listeners.send_sync_ssh_command({ device: target.device, command: 'false' }, {}),
    /setup\.command\.failed/
  );
  assert.deepEqual(target.connectionUpdates, [true]);
});

test('a rejected sync command does not declare the SSH target disconnected', async () => {
  const DeviceClass = loadDeviceClass();
  const listeners = await createListeners(DeviceClass);
  const target = createTarget();
  executeCommand = async () => {
    throw new Error('transport failed');
  };

  await assert.rejects(
    listeners.send_sync_ssh_command({ device: target.device, command: 'uptime' }, {}),
    /transport failed/
  );
  assert.deepEqual(target.connectionUpdates, []);
});

test('a non-zero async command exit still records a successful SSH connection', async () => {
  const DeviceClass = loadDeviceClass();
  const listeners = await createListeners(DeviceClass);
  const target = createTarget();
  executeCommand = async () => ({ stdout: '', stderr: 'failed', code: 1, signal: null });

  await listeners.send_async_ssh_command({ device: target.device, command: 'false' }, {});
  await settleAsyncListener();
  assert.deepEqual(target.connectionUpdates, [true]);
});

test('a rejected async command leaves connection state to the health check', async () => {
  const DeviceClass = loadDeviceClass();
  const listeners = await createListeners(DeviceClass);
  const target = createTarget();
  executeCommand = async () => {
    throw new Error('transport failed');
  };

  await listeners.send_async_ssh_command({ device: target.device, command: 'uptime' }, {});
  await settleAsyncListener();
  assert.deepEqual(target.connectionUpdates, []);
});

test('a failed periodic login check declares the SSH target disconnected', async () => {
  const DeviceClass = loadDeviceClass();
  const target = createTarget();
  target.device.healthCheckRunning = false;
  testConnection = async () => {
    throw new Error('login failed');
  };

  await DeviceClass.prototype.runHealthCheck.call(target.device);
  assert.deepEqual(target.connectionUpdates, [false]);
});
