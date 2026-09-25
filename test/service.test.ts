import { describe, expect, it } from 'vitest';

import { appDirectory, macPlist, relayArguments, systemdUnit, windowsLauncher, windowsTaskXml, type ServiceConfig } from '../src/service.js';

const windowsConfig: ServiceConfig = {
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  scriptPath: 'C:\\My Projects\\Crosschat\\dist\\index.js',
  dataDir: 'C:\\Users\\sam\\AppData\\Roaming\\crosschat-relay',
  port: 4318,
  host: '127.0.0.1',
  logFile: 'C:\\Users\\sam\\AppData\\Roaming\\crosschat-relay\\logs\\relay.log',
  installedAt: '2026-09-24T00:00:00.000Z',
};

const unixConfig: ServiceConfig = {
  nodePath: '/usr/local/bin/node',
  scriptPath: '/Users/sam/My Apps/crosschat & co/dist/index.js',
  env: { ELECTRON_RUN_AS_NODE: '1' },
  dataDir: '/Users/sam/Library/Application Support/crosschat-relay',
  port: 5000,
  host: '127.0.0.1',
  allowedHosts: 'localhost',
  logFile: '/Users/sam/Library/Application Support/crosschat-relay/logs/relay.log',
  installedAt: '2026-09-24T00:00:00.000Z',
};

describe('background service files', () => {
  it('passes the port, data directory, and log file to the relay', () => {
    expect(relayArguments(unixConfig)).toEqual([
      unixConfig.scriptPath,
      '--port',
      '5000',
      '--host',
      '127.0.0.1',
      '--data-dir',
      unixConfig.dataDir,
      '--log-file',
      unixConfig.logFile,
      '--allowed-hosts',
      'localhost',
    ]);
  });

  it('writes a Windows launcher that quotes paths with spaces and stops on the stop flag', () => {
    const launcher = windowsLauncher(windowsConfig);
    // Inside a VBScript string, "" is a literal quote, so each path arrives quoted.
    expect(launcher).toContain('shell.Run """C:\\Program Files\\nodejs\\node.exe"" ""C:\\My Projects\\Crosschat\\dist\\index.js""');
    expect(launcher).toContain(', 0, True');
    expect(launcher).toContain('stopFlag = "C:\\Users\\sam\\AppData\\Roaming\\crosschat-relay\\service.stopped"');
    expect(launcher).toContain('If fso.FileExists(stopFlag) Then Exit Do');
  });

  it('writes a Task Scheduler task that runs at logon without admin rights', () => {
    const xml = windowsTaskXml('C:\\Users\\a&b\\launcher.vbs', 'DOMAIN\\sam');
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    // Quotes are fine as-is in element text; only & and < need escaping.
    expect(xml).toContain('//B //Nologo "C:\\Users\\a&amp;b\\launcher.vbs"');
  });

  it('writes a launchd agent that starts at login and stays alive', () => {
    const plist = macPlist(unixConfig);
    expect(plist).toContain('<string>/Users/sam/My Apps/crosschat &amp; co/dist/index.js</string>');
    expect(plist).toContain('<key>KeepAlive</key>\n  <true/>');
    expect(plist).toContain('<key>ELECTRON_RUN_AS_NODE</key>');
    expect(plist).toContain('service-output.log');
  });

  it('writes a systemd unit with every argument quoted', () => {
    const unit = systemdUnit(unixConfig);
    expect(unit).toContain('ExecStart="/usr/local/bin/node" "/Users/sam/My Apps/crosschat & co/dist/index.js" "--port" "5000"');
    expect(unit).toContain('Environment="ELECTRON_RUN_AS_NODE=1"');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('keeps data in the usual per-user app folder on each platform', () => {
    expect(appDirectory('win32', { USERPROFILE: 'C:\\Users\\x' })).toMatch(/Users[\\/]x[\\/]\.crosschat-relay$/);
    expect(appDirectory('darwin', {})).toMatch(/Library[\\/]Application Support[\\/]crosschat-relay$/);
    expect(appDirectory('linux', { XDG_DATA_HOME: '/home/x/.data' })).toMatch(/[\\/]home[\\/]x[\\/]\.data[\\/]crosschat-relay$/);
  });
});
