/**
 * CLI: rebuild the demo database from scratch.
 *   npm run db:reset --workspace server
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { SqliteDb } from './sqlite.js';
import { seedDemoData } from './seed.js';

async function main() {
  if (config.db.driver !== 'sqlite') {
    console.error(
      '[reset] DB_DRIVER is "postgres". Refusing to drop a production database.\n' +
        '[reset] Run with DB_DRIVER=sqlite to rebuild the demo dataset.',
    );
    process.exit(1);
  }

  const file = path.resolve(config.db.sqliteFile);
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${file}${suffix}`;
    if (fs.existsSync(f)) {
      fs.rmSync(f);
      console.log(`[reset] removed ${f}`);
    }
  }

  const db = new SqliteDb(config.db.sqliteFile);
  db.migrate();
  console.log('[reset] schema created');
  await seedDemoData(db, { verbose: true });
  await db.close();
  console.log('[reset] done');
}

main().catch((err) => {
  console.error('[reset] failed:', err);
  process.exit(1);
});
