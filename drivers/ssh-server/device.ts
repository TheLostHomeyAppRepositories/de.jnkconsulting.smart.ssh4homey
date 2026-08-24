import Homey, {FlowCardTrigger, FlowCardTriggerDevice} from 'homey';
import {AuthenticationType, SSHServerConfig} from '../../src/model/ServerConfig';
import {CommandResult, SSHApi} from '../../src/api/api';
import {updateCapability} from '../../src/homey/utils';

class SSHServerDevice extends Homey.Device {

  private asyncResponseTriggerCard: FlowCardTriggerDevice | null = null;
  private asyncResponseErrorTriggerCard: FlowCardTriggerDevice | null = null;
  private globalErrorTriggerCard: FlowCardTrigger | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private healthCheckRunning = false;
  private static readonly HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000;
  private static listenersRegistered = false;

  async onInit() {
    this.log('SSHServerDevice initializing');
    this.asyncResponseTriggerCard = this.homey.flow.getDeviceTriggerCard('async_ssh_command_success');
    this.asyncResponseErrorTriggerCard = this.homey.flow.getDeviceTriggerCard('async_ssh_command_failed');
    try {
      this.globalErrorTriggerCard = this.homey.flow.getTriggerCard('global_ssh_command_failed');
    } catch (e) {
      this.error('Global flow card not registered: global_ssh_command_failed', e);
      this.globalErrorTriggerCard = null;
    }

    if (!SSHServerDevice.listenersRegistered) {
      SSHServerDevice.listenersRegistered = true;
      const syncCommandCard = this.homey.flow.getActionCard('send_sync_ssh_command');
      syncCommandCard.registerRunListener(async (args, state) => {
        const cardResult = new Promise<any>(async (resolve, reject) => {

          const device: SSHServerDevice = args.device;
          const api = new SSHApi(device.loadConfig(), device.log, this.homey.__);
          device.log("Executing sync command: " + args.command)

          api.executeCommand(args.command)
              .then(async result => {
                if (result.code !== null && result.code !== undefined && result.code !== 0) {
                  const errorMessage = device.homey.__('setup.command.failed', {
                    code: result.code,
                    stderr: result.stderr || ''
                  });
                  device.error("Sync command failed (non-zero exit): " + args.command + ' - ' + errorMessage)
                  device.triggerGlobalError(args.command, errorMessage);
                  await device.updateConnectionRelatedCapabilities(true);
                  reject(new Error(errorMessage))
                  return;
                }

                device.log("Sync command succeeded: " + args.command)
                await device.updateConnectionRelatedCapabilities(true);
                let response = {
                  stdout: result.stdout,
                  stderr: result.stderr,
                  signal: "",
                  code: -1
                }

                if (result.signal) {
                  response.signal = result.signal
                }

                if (result.code !== null && result.code !== undefined) {
                  response.code = result.code
                }

                resolve(response);
              })
              .catch(async e => {
                device.error("Sync command failed: " + args.command, e)
                device.triggerGlobalError(args.command, device.normalizeErrorMessage(e));
                reject(e)
              })
        })
        return cardResult;
      });

      const asyncCommandCard = this.homey.flow.getActionCard('send_async_ssh_command');
      asyncCommandCard.registerRunListener(async (args, state) => {
        const device: SSHServerDevice = args.device;
        const api = new SSHApi(device.loadConfig(), device.log, this.homey.__);
        device.log("Executing async command: " + args.command)
        api.executeCommand(args.command)
            .then(result => {
              try {
                if (result.code !== null && result.code !== undefined && result.code !== 0) {
                  const errorMessage = device.homey.__('setup.command.failed', {
                    code: result.code,
                    stderr: result.stderr || ''
                  });
                  device.error("Async command failed (non-zero exit): " + args.command + ' - ' + errorMessage)
                  device.updateConnectionRelatedCapabilities(true)
                      .catch(e => device.error('Failed to update capabilities after successful SSH connection', e));
                  device.triggerGlobalError(args.command, errorMessage);
                  const response = {
                    command: args.command,
                    errormessage: errorMessage
                  }
                  device.asyncResponseErrorTriggerCard
                      ?.trigger(device, response, state)
                      .then(() => device.log('Async error card triggered'))
                      .catch(device.error)
                  return;
                }

                device.log("Async command succeeded: " + args.command)
                let response = {
                  command: args.command,
                  stdout: result.stdout,
                  stderr: result.stderr,
                  signal: "",
                  code: -1
                }
                if (result.signal) {
                  response.signal = result.signal
                }

                if (result.code !== null && result.code !== undefined) {
                  response.code = result.code
                }
                device.log("Updating capabilities: " + args.command)
                device.updateConnectionRelatedCapabilities(true)
                    .catch(e => device.error('Failed to update capabilities after async command success', e));
                device.log("Triggering response card: " + args.command)
                device.asyncResponseTriggerCard
                    ?.trigger(device, response, state)
                    .then(() => device.log('Async success card triggered'))
                    .catch(device.error)
              } catch (e) {
                device.error("Async command handler failed: " + args.command, e)
                device.triggerGlobalError(args.command, device.normalizeErrorMessage(e));
              }
            })
            .catch(e => {
              device.error("Async command failed: " + args.command, e);
              const errorMessage = device.normalizeErrorMessage(e);
              const response = {
                command: args.command,
                errormessage: errorMessage
              }
              device.asyncResponseErrorTriggerCard
                  ?.trigger(device, response, state)
                  .then(() => device.log('Async error card triggered'))
                  .catch(device.error)
              device.triggerGlobalError(args.command, errorMessage);
            })
      });
    }

    this.startHealthCheck();
  }

  async onAdded() {
    this.log('SSHServerDevice added');
    const storedSettings: SSHServerConfig = this.getStoreValue('settings');
    const updatedSettings = {
      host: storedSettings.host,
      port: storedSettings.port,
      username: storedSettings.credentials.username
    }
    const credentials = storedSettings.credentials
    // @ts-ignore
    this.addOptionalSetting('password', credentials.password, updatedSettings)
    // @ts-ignore
    this.addOptionalSetting('privateKey', credentials.privateKey, updatedSettings)
    // @ts-ignore
    this.addOptionalSetting('passphrase', credentials.passphrase, updatedSettings)

    this.addOptionalSetting('kexAlgorithm', storedSettings.kexAlgorithm, updatedSettings)
    this.addOptionalSetting('cipherAlgorithm', storedSettings.cipherAlgorithm, updatedSettings)
    this.addOptionalSetting('hostKeyAlgorithm', storedSettings.hostKeyAlgorithm, updatedSettings)
    this.addOptionalSetting('hmac', storedSettings.hmac, updatedSettings)
    this.addOptionalSetting('compression', storedSettings.compression, updatedSettings)

    await this.setSettings(updatedSettings)
    await this.unsetStoreValue('settings')
    const api = new SSHApi(this.loadConfig(), this.log, this.homey.__);
    try {
      await api.connectionTest()
      await this.updateConnectionRelatedCapabilities(true);
    } catch (e) {
      await this.updateConnectionRelatedCapabilities(false);
    }
  }

  private addOptionalSetting(key: string, value: string | undefined, target: any) {
    if (value) {
      // @ts-ignore
      target[key] = value
    }
    else {
      // @ts-ignore
      target[key] = ''
    }
  }

  async onSettings(event: { oldSettings: {}, newSettings: {}, changedKeys: [] }): Promise<string|void> {
    this.log('Settings updated for device');
    const newConvertedSettings = this.parseConfig(event.newSettings)
    const api = new SSHApi(newConvertedSettings, this.log, this.homey.__);
    const settingsResult = new Promise<string| void>((resolve, reject) => {
      api.connectionTest()
          .then(async result => {
            await this.updateConnectionRelatedCapabilities(true);
            this.log('Settings validation succeeded');
            resolve()
          })
          .catch(e => {
            this.log('Settings validation failed', e)
            reject(e.toString())
          })
    })
    return settingsResult;
  }

  private async updateConnectionRelatedCapabilities(success: boolean) {
    if (success) {
      const now = new Date();

      const formattedNow = now.toLocaleDateString('de-DE', {year: "numeric", month: "numeric", day: "numeric"}) + ' - ' + now.toLocaleTimeString('de-DE');
      await updateCapability(this, 'last_connected', formattedNow);
      await updateCapability(this, 'alarm_connection_failed', false);
    }
    else {
      await updateCapability(this, 'alarm_connection_failed', true);
    }
  }

  private startHealthCheck() {
    if (this.healthCheckInterval) {
      this.homey.clearInterval(this.healthCheckInterval);
    }

    this.healthCheckInterval = this.homey.setInterval(() => {
      this.runHealthCheck().catch(this.error);
    }, SSHServerDevice.HEALTH_CHECK_INTERVAL_MS);

    this.log('Health check scheduled every ' + (SSHServerDevice.HEALTH_CHECK_INTERVAL_MS / 1000) + 's');
    this.runHealthCheck().catch(this.error);
  }

  private async runHealthCheck() {
    if (this.healthCheckRunning) {
      return;
    }
    this.healthCheckRunning = true;
    const api = new SSHApi(this.loadConfig(), this.log, this.homey.__);
    try {
      await api.connectionTest();
      this.log('Health check succeeded');
      await this.updateConnectionRelatedCapabilities(true);
    } catch (e) {
      this.log('Health check failed', e);
      await this.updateConnectionRelatedCapabilities(false);
    } finally {
      this.healthCheckRunning = false;
    }
  }

  async onDeleted() {
    if (this.healthCheckInterval) {
      this.homey.clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    this.log('SSHServerDevice deleted');
  }

  private loadConfig(): SSHServerConfig {
    return this.parseConfig(this.getSettings());
  }

  private parseConfig(from: any): SSHServerConfig {
    let authType = AuthenticationType.USERNAME_PASSWORD
    if (from.privateKey && from.privateKey !== '') {
      authType = AuthenticationType.PRIVATE_KEY
    }
    const parsingResult: SSHServerConfig = {
      name: this.getName(),
      host: from.host,
      port: from.port,
      authType: authType,
      credentials: {
        username: from.username,
        password: from.password,
        privateKey: from.privateKey,
        passphrase: from.passphrase
      },
      compression: from.compression,
      hmac: from.hmac,
      cipherAlgorithm: from.cipherAlgorithm,
      kexAlgorithm: from.kexAlgorithm,
      hostKeyAlgorithm: from.hostKeyAlgorithm
    }
    return parsingResult
  }

  private triggerGlobalError(command: string, errorMessage: string) {
    if (!this.globalErrorTriggerCard) {
      return;
    }
    const settings = this.getSettings() as { host?: string };
    const data = this.getData() as { id?: string };
    const tokens = {
      device_name: this.getName(),
      device_id: data && data.id ? String(data.id) : '',
      host: settings && settings.host ? String(settings.host) : '',
      command: command,
      errormessage: errorMessage
    };
    this.globalErrorTriggerCard
        .trigger(tokens)
        .then(() => this.log('Global error card triggered'))
        .catch(this.error);
  }

  private normalizeErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return String(error);
  }

}

module.exports = SSHServerDevice;
