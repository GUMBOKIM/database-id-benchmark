// Usage: node src/report.js results/<RUN_ID>
// Reads every <db>.json in the run folder and writes REPORT.md (tables) and
// summary.csv (one row per db × type × size, for charts).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ID_TYPES } from './ids.js';

const dir = process.argv[2] ?? `results/${readdirSync('results').filter((d) => !d.startsWith('_')).sort().at(-1)}`;
const dbs = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')));
const order = ['postgres', 'mysql', 'mariadb', 'oracle', 'mssql', 'sqlite', 'sqlite_norowid'];
dbs.sort((a, b) => order.indexOf(a.db) - order.indexOf(b.db));

const out = [];
const p = (s = '') => out.push(s);
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 1e5 ? 0 : 1)}k` : String(n));
const sizeLabel = (n) => (n >= 1e6 ? `${n / 1e6}M` : n >= 1e3 ? `${n / 1e3}k` : String(n));
const types = Object.keys(ID_TYPES);

function grid(db, title, cell) {
	const sizes = [...new Set(db.runs.map((r) => r.n))].sort((a, b) => a - b);
	p(`#### ${title}\n`);
	p(`| ID | ${sizes.map(sizeLabel).join(' | ')} |`);
	p(`| --- | ${sizes.map(() => '---:').join(' | ')} |`);
	for (const t of types) {
		if (!db.runs.some((r) => r.type === t)) continue;
		p(`| ${ID_TYPES[t].label} | ${sizes.map((n) => { const r = db.runs.find((x) => x.type === t && x.n === n); return r ? cell(r) : ''; }).join(' | ')} |`);
	}
	p();
}

// Server-side time when the database reports it, otherwise what the client measured.
const lookupCell = (l) => (l.server ? `${l.server.serverUs.toFixed(0)}` : `${l.p50us.toFixed(0)}*`);

p(`# Results: ${dir.split('/').at(-1)}\n`);
const c = dbs[0]?.config;
if (c) p(`Sizes ${c.sizes.join(', ')} (≥ ${c.bigN.toLocaleString()} rows: ${c.bigTypes.join(', ')} only), batch ${c.batch}, ${c.lookups.toLocaleString()} lookups, cache ${c.cacheMb} MB, concurrent ${c.concWorkers} × ${c.concRows.toLocaleString()} rows.\n`);

p('## Environment\n');
p('| DB | Version | Cache | CPU ref before → after (M/s) | Recheck (rows/s, first → again) |');
p('| --- | --- | --- | --- | --- |');
for (const db of dbs) {
	const rc = db.recheck ? `${db.recheck.type} ${sizeLabel(db.recheck.n)}: ${k(db.recheck.firstRowsPerSec)} → ${k(db.recheck.againRowsPerSec)}` : '';
	p(`| ${db.db} | ${String(db.env.version).split('\n')[0].slice(0, 70)} | ${db.env.cache} | ${db.calibration.before} → ${db.calibration.after ?? '?'} | ${rc} |`);
}
p();

const gen = dbs[0]?.generation ?? {};
if (Object.keys(gen).length) {
	p('## ID generation (Node.js)\n');
	p('| ID | ns / id |\n| --- | ---: |');
	for (const t of types) if (gen[t]) p(`| ${ID_TYPES[t].label} | ${gen[t].nsPerId.toFixed(0)} |`);
	p();
}

for (const db of dbs) {
	p(`## ${db.db}\n`);
	grid(db, 'Insert, rows/s', (r) => k(r.insert.rowsPerSec));
	grid(db, 'Insert, last 10% ÷ first 10% of the table', (r) => (r.insert.slices.length > 1 ? (r.insert.slices.at(-1) / r.insert.slices[0]).toFixed(2) : ''));
	grid(db, 'Size, bytes per row (table + indexes)', (r) => Math.round((r.size.tableBytes + r.size.indexBytes) / r.n));
	grid(db, 'Size, MiB table / indexes', (r) => `${(r.size.tableBytes / 2 ** 20).toFixed(1)} / ${(r.size.indexBytes / 2 ** 20).toFixed(1)}`);
	grid(db, 'Lookup by id, µs (server; * = client p50)', (r) => lookupCell(r.byId));
	grid(db, 'Lookup by id, disk reads per query', (r) => (r.byId.server ? r.byId.server.readsPerCall.toFixed(2) : ''));
	grid(db, 'Lookup by email, µs (server; * = client p50)', (r) => lookupCell(r.byEmail));
	if (db.concurrent.length) {
		p(`#### Concurrent single-row inserts (${db.concurrent[0].workers} connections, ${db.concurrent[0].rows.toLocaleString()} rows)\n`);
		p('| ID | rows/s |\n| --- | ---: |');
		for (const x of db.concurrent) p(`| ${ID_TYPES[x.type].label} | ${k(x.rowsPerSec)} |`);
		p();
	}
}

writeFileSync(`${dir}/REPORT.md`, out.join('\n'));

const csv = [['db', 'type', 'n', 'insert_rows_per_sec', 'insert_last_over_first', 'table_bytes', 'index_bytes',
	'id_client_p50_us', 'id_server_us', 'id_reads_per_call', 'email_client_p50_us', 'email_server_us', 'email_reads_per_call'].join(',')];
for (const db of dbs) {
	for (const r of db.runs) {
		csv.push([db.db, r.type, r.n, r.insert.rowsPerSec, r.insert.slices.length > 1 ? (r.insert.slices.at(-1) / r.insert.slices[0]).toFixed(3) : '',
			r.size.tableBytes, r.size.indexBytes,
			r.byId.p50us.toFixed(1), r.byId.server?.serverUs.toFixed(1) ?? '', r.byId.server?.readsPerCall.toFixed(3) ?? '',
			r.byEmail.p50us.toFixed(1), r.byEmail.server?.serverUs.toFixed(1) ?? '', r.byEmail.server?.readsPerCall.toFixed(3) ?? ''].join(','));
	}
}
writeFileSync(`${dir}/summary.csv`, csv.join('\n') + '\n');
console.log(`wrote ${dir}/REPORT.md and ${dir}/summary.csv`);
