const fs = require('fs/promises');
const path = require('path');
const pool = require('./pool');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

// Divide un fichero SQL en statements individuales. Pensado para migraciones
// simples (CREATE TABLE/INDEX, ALTER TABLE, INSERT). No soporta procedures
// con $$ ni strings con punto y coma dentro.
function splitStatements(sql) {
  const noLineComments = sql.split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  return noLineComments
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function ensureMigrationsTable(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS migrations_applied (
      filename VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
}

async function getAppliedMigrations(connection) {
  const [rows] = await connection.query('SELECT filename FROM migrations_applied');
  return new Set(rows.map((r) => r.filename));
}

async function runMigrations() {
  const connection = await pool.getConnection();
  try {
    await ensureMigrationsTable(connection);
    const applied = await getAppliedMigrations(connection);

    const files = await fs.readdir(MIGRATIONS_DIR);
    const sqlFiles = files.filter((f) => f.endsWith('.sql')).sort();

    let appliedNow = 0;
    for (const file of sqlFiles) {
      if (applied.has(file)) continue;
      const filePath = path.join(MIGRATIONS_DIR, file);
      const sql = await fs.readFile(filePath, 'utf-8');
      const statements = splitStatements(sql);
      console.log(`Running migration: ${file} (${statements.length} statements)`);
      for (const stmt of statements) {
        try {
          await connection.query(stmt);
        } catch (err) {
          // Idempotencia defensiva: si un fichero se re-ejecuta porque un statement
          // posterior falló (y no se marcó como aplicado), un ALTER ADD ya aplicado
          // devolvería "Duplicate column/key". Lo toleramos para no dejar el arranque
          // en bucle de fallo permanente (process.exit) — el resto de errores SÍ se propagan.
          if (err && (err.errno === 1060 || err.errno === 1061)) { // ER_DUP_FIELDNAME / ER_DUP_KEYNAME
            console.warn(`  (omitido: ${err.code || err.errno} — ya aplicado) ${stmt.slice(0, 60)}…`);
          } else {
            throw err;
          }
        }
      }
      await connection.execute(
        'INSERT INTO migrations_applied (filename) VALUES (?)',
        [file],
      );
      appliedNow += 1;
    }

    if (appliedNow === 0) {
      console.log('Migrations up to date');
    } else {
      console.log(`Applied ${appliedNow} new migration(s)`);
    }
  } finally {
    connection.release();
  }
}

module.exports = { runMigrations };
