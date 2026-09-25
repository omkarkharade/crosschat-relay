import { execFile } from 'node:child_process';
import { parseArgs } from 'node:util';

import * as service from './service.js';

const SERVICE_HELP = `Usage: crosschat-relay service <command> [options]

Run the relay in the background: it starts when you log in and restarts if it
stops unexpectedly. No administrator rights are needed.

Commands:
  install      Install and start the background service
  uninstall    Stop and remove the service (your data is kept)
  start        Start the service
  stop         Stop it until the next start or login
  restart      Restart it (for example after upgrading)
  status       Show whether it is installed, running, and healthy
  logs         Print the end of the relay log (--lines <n>, default 50)

Options for install:
  -p, --port <port>          Port to listen on (default 4318)
      --host <host>          Interface to bind (default 127.0.0.1)
  -d, --data-dir <dir>       Where to keep data (default: your app data folder)
      --allowed-hosts <list> Host names to accept when binding beyond localhost`;

/** Handle `crosschat-relay service ...`. Returns the process exit code. */
export async function runServiceCommand(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string' },
      'data-dir': { type: 'string', short: 'd' },
      'allowed-hosts': { type: 'string' },
      lines: { type: 'string' },
    },
    strict: true,
  });

  try {
    switch (command) {
      case 'install': {
        const status = await service.install({
          ...(values.port ? { port: Number(values.port) } : {}),
          ...(values.host ? { host: values.host } : {}),
          ...(values['data-dir'] ? { dataDir: values['data-dir'] } : {}),
          ...(values['allowed-hosts'] ? { allowedHosts: values['allowed-hosts'] } : {}),
        });
        printStatus(status);
        console.log(`\nThe relay now starts automatically when you log in.`);
        console.log(`Sign in to the dashboard with the admin token in ${status.config!.dataDir}${sep()}api-token`);
        if (process.platform === 'linux') {
          console.log('To keep it running while you are logged out, run: loginctl enable-linger $USER');
        }
        return 0;
      }
      case 'uninstall':
        await service.uninstall();
        console.log('The relay service was removed. Your data folder was kept.');
        return 0;
      case 'start':
        printStatus(await service.start());
        return 0;
      case 'stop':
        await service.stop();
        console.log('The relay is stopped. It starts again at your next login, or with "crosschat-relay service start".');
        return 0;
      case 'restart':
        printStatus(await service.restart());
        return 0;
      case 'status': {
        const status = await service.status();
        printStatus(status);
        return status.installed && status.healthy ? 0 : 3;
      }
      case 'logs':
        process.stdout.write(`${await service.logs(values.lines ? Number(values.lines) : 50)}\n`);
        return 0;
      case undefined:
      case 'help':
      case '--help':
        console.log(SERVICE_HELP);
        return 0;
      default:
        console.error(`Unknown service command "${command}".\n\n${SERVICE_HELP}`);
        return 2;
    }
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/** Handle `crosschat-relay open`: open the dashboard in the default browser. */
export async function openDashboard(): Promise<number> {
  const status = await service.status();
  const url = status.dashboardUrl ?? 'http://localhost:4318/';
  const [command, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  await new Promise<void>((resolve) => execFile(command as string, args as string[], () => resolve()));
  console.log(`Opened ${url}`);
  return 0;
}

function printStatus(status: service.ServiceStatus): void {
  if (!status.installed) {
    console.log('The relay service is not installed. Run "crosschat-relay service install".');
    return;
  }
  const state = status.healthy ? 'running and healthy' : status.running ? 'running but not answering' : 'stopped';
  console.log(`Crosschat relay service: ${state}`);
  console.log(`  Dashboard: ${status.dashboardUrl}`);
  console.log(`  Data:      ${status.config!.dataDir}`);
  console.log(`  Log:       ${status.config!.logFile}`);
}

const sep = () => (process.platform === 'win32' ? '\\' : '/');
