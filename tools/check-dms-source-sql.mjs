/** Execute exported metadata SQL in ephemeral PGlite/PostgreSQL with synthetic tables only.
 * PGLITE_MODULE points to a separately installed test-only module (not an application dependency).
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { defaultValues } from '../src/kit/blueprint.ts';
import { AWS_DMS_SERVICE } from '../src/cloud/aws-dms-service.ts';
const { PGlite } = await import(pathToFileURL(resolve(process.env.PGLITE_MODULE || '.work/tmp/dms-sql-runtime/node_modules/@electric-sql/pglite/dist/index.js')).href);
const certificate = 'arn:aws:dms:us-east-1:123456789012:cert:ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const values = { ...defaultValues(AWS_DMS_SERVICE), aws_region: 'us-east-1', name: 'mock-cdc', mode: 'full-load-and-cdc', host: 'EXISTING', existing: 'migration-host', secret_role: 'arn:aws:iam::123456789012:role/DmsSecrets', source_secret: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:source-abcdef', target_secret: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:target-abcdef', source_database: 'postgres', target_database: 'target', source_certificate: certificate, target_certificate: certificate, tables: 'public | customer_records' };
function source(overrides = {}) {
  const result = AWS_DMS_SERVICE.build({ ...values, ...overrides });
  assert.deepEqual(result.findings, []);
  // psql's ON_ERROR_STOP is a client directive; exec already rejects SQL errors.
  return result.files['SOURCE-CHECK.sql'].replace(/^\\set ON_ERROR_STOP on\r?\n/, '');
}
const db = await PGlite.create({ postgresqlconf: ['wal_level=logical', 'max_replication_slots=10', 'max_wal_senders=10'] });
let count = 0;
try {
  await db.exec('CREATE TABLE public.customer_records(id integer PRIMARY KEY, label text); INSERT INTO public.customer_records VALUES (1, \'synthetic\'); CREATE TABLE public.no_primary_key(id integer); CREATE TABLE public.rls_table(id integer PRIMARY KEY); ALTER TABLE public.rls_table ENABLE ROW LEVEL SECURITY; CREATE ROLE dms_reader LOGIN REPLICATION; CREATE ROLE no_replication LOGIN; GRANT USAGE ON SCHEMA public TO dms_reader, no_replication; GRANT SELECT ON public.customer_records TO dms_reader, no_replication; CREATE SCHEMA restricted; CREATE TABLE restricted.records(id integer PRIMARY KEY); GRANT SELECT ON restricted.records TO dms_reader;');
  const cases = [
    { name: 'valid-owner', sql: source() },
    { name: 'valid-migration-role', role: 'dms_reader', sql: source() },
    { name: 'wrong-database', sql: source({ source_database: 'wrong_database' }), error: /Wrong source database/ },
    { name: 'missing-table', sql: source({ tables: 'public | absent' }), error: /primary-key\/SELECT/ },
    { name: 'missing-primary-key', sql: source({ tables: 'public | no_primary_key' }), error: /primary-key\/SELECT/ },
    { name: 'row-security', sql: source({ tables: 'public | rls_table' }), error: /primary-key\/SELECT/ },
    { name: 'no-replication', role: 'no_replication', sql: source(), error: /lacks replication privilege/ },
    { name: 'no-schema-usage', role: 'dms_reader', sql: source({ tables: 'restricted | records' }), error: /primary-key\/SELECT/ },
  ];
  for (const item of cases) {
    await db.exec('RESET ROLE');
    if (item.role) await db.exec('SET ROLE ' + item.role);
    let failure;
    try { await db.exec(item.sql); } catch (error) { failure = error; }
    finally { await db.exec('ROLLBACK'); }
    if (item.error) assert.match(String(failure?.message), item.error, item.name);
    else assert.equal(failure, undefined, item.name + ': ' + failure?.message);
    count++;
  }
  await db.exec('RESET ROLE');
  assert.equal((await db.query('SELECT count(*)::int AS count FROM public.customer_records')).rows[0].count, 1);
} finally { await db.close(); }
const nonLogical = await PGlite.create();
try {
  await assert.rejects(nonLogical.exec(source()), /configure logical WAL/);
  count++;
} finally { await nonLogical.close(); }
console.log('Passed ' + count + ' generated source-SQL cases in ephemeral PostgreSQL; no external database, DMS task or migration connection.');
