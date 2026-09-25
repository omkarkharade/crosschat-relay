// node:sqlite prints an ExperimentalWarning when it loads. The relay depends on
// it deliberately, so hide that one warning and keep every other. This module
// must be imported before anything that imports node:sqlite.
const emitWarning = process.emitWarning.bind(process);

process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const message = typeof warning === 'string' ? warning : warning.message;
  if (message.includes('SQLite is an experimental feature')) return;
  (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

export {};
