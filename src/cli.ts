#!/usr/bin/env node
// Command-line entry point: `service` and `open` subcommands, or the relay itself.
import './quiet-sqlite-warning.js';

const [subcommand] = process.argv.slice(2);

if (subcommand === 'service' || subcommand === 'open') {
  const { openDashboard, runServiceCommand } = await import('./service-cli.js');
  // Set the exit code and let Node exit on its own: calling process.exit()
  // while a fetch connection is still closing can crash Node on Windows.
  process.exitCode = subcommand === 'service' ? await runServiceCommand(process.argv.slice(3)) : await openDashboard();
} else {
  await import('./index.js');
}
