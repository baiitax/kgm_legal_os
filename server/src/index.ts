/**
 * Bootstrap.
 *
 *   npm run dev     — tsx watch
 *   npm start       — production
 *
 * Refuses to start in production with an unconfigured secret, an unconfigured
 * database, or the development router reachable.
 */
import { config, isProd } from './config.js';
import { createContainer } from './container.js';
import { createApp } from './app.js';
import { getDb, closeDb } from './db/index.js';
import { seedDemoData } from './db/seed.js';
import { SqliteDb } from './db/sqlite.js';

async function main() {
  const db = getDb();
  const container = createContainer({ db });

  if (config.demo.seedOnBoot && db instanceof SqliteDb) {
    // The container is built first so the seed can materialize the placeholder
    // bytes behind every demo document through the real storage driver.
    await seedDemoData(db, {
      verbose: process.env.QUIET_SEED !== '1',
      storage: container.storage,
    });
  }

  const app = createApp(container);

  const server = app.listen(config.port, config.host, () => {
    const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
    console.log('');
    console.log('  KGM LEGAL OS — Client Portal');
    console.log('  ────────────────────────────────────────────────');
    console.log(`  env        ${config.env}`);
    console.log(`  listening  http://${shown}:${config.port}`);
    console.log(`  database   ${config.db.driver}`);
    console.log(`  storage    ${container.storage.name}`);
    console.log(`  dev routes ${isProd ? 'DISABLED' : 'enabled (/api/dev)'}`);
    console.log('  ────────────────────────────────────────────────');
    console.log('');
  });

  // Housekeeping: drop dead sessions hourly.
  const gc = setInterval(() => {
    container.repo.purgeExpiredSessions().catch(() => undefined);
  }, 60 * 60 * 1000);
  gc.unref();

  const shutdown = async (signal: string) => {
    console.log(`\n[boot] ${signal} received, shutting down`);
    clearInterval(gc);
    server.close();
    await closeDb().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // A rejected promise in a background task must not leave the process in an
  // undefined state, and must not print a stack to a client.
  process.on('unhandledRejection', (reason) => {
    console.error('[boot] unhandled rejection:', reason instanceof Error ? reason.message : reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[boot] uncaught exception:', err);
    void shutdown('uncaughtException');
  });
}

main().catch((err) => {
  console.error('[boot] failed to start:', err);
  process.exit(1);
});
