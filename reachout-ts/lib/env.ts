/**
 * Import FIRST in every non-Next entry point (cli.ts, worker.ts,
 * scheduler.ts). Next.js loads .env automatically for the app, but
 * plain tsx processes do not — config.ts reads process.env at module
 * load, so this must run before any lib/ import is evaluated.
 * Node 24's native loader: no dotenv dependency.
 */
try {
  process.loadEnvFile();
} catch {
  // .env absent — defaults in config.ts still apply.
}
