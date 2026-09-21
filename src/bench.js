// Runs every ID type at every size against ONE database, inside the runner container.
// Usage (normally via bench.sh): node src/bench.js <db>
// Writes results/<RUN_ID>/<db>.json after every measurement, so a crash keeps what ran.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ID_TYPES, emailOf } from './ids.js';
import { SIZES, BATCH, LOOKUPS, CONC_WORKERS, CONC_ROWS, RUN_ID, typesFor, maxNFor, TYPES, BIG_N, BIG_TYPES, CACHE_MB } from './config.js';
import postgres from './adapters/postgres.js';
import { mysqlAdapter, mariadbAdapter } from './adapters/mysql.js';
import oracle from './adapters/oracle.js';
import mssql from './adapters/mssql.js';
import { sqliteAdapter, sqliteNoRowidAdapter } from './adapters/sqlite.js';

const ADAPTERS = { postgres, mysql: mysqlAdapter, mariadb: mariadbAdapter, oracle, mssql, sqlite: sqliteAdapter, sqlite_norowid: sqliteNoRowidAdapter };
const adapter = ADAPTERS[process.argv[2]];
if (!adapter) throw new Error(`usage: node src/bench.js <${Object.keys(ADAPTERS).join('|')}>`);

const log = (...m) => console.log(new Date().toISOString().slice(11, 19), `[${adapter.name}]`, ...m);
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const seconds = (t0) => Number(process.hrtime.bigint() - t0) / 1e9;

// ---------------------------------------------------------------- data

const NAMES = ['Kim Minjun', 'Lee Seoyeon', 'Park Jiho', 'Choi Yuna', 'Jung Hayoon', 'Alex Smith', 'Maria Garcia', 'Wei Chen'];
const makeUser = (i) => ({
	email: emailOf(i),
	name: NAMES[i % NAMES.length],
	passwordHash: `$2b$10$${randomBytes(40).toString('base64').replace(/[+/=]/g, 'x').slice(0, 53)}`,
});

// IDs come from cache/<type>.txt (src/gen.js), one type in memory at a time.
function loadIds(type) {
	if (ID_TYPES[type].kind === 'db') return null;
	const file = `cache/${type}.txt`;
	if (!existsSync(file)) throw new Error(`${file} missing; run src/gen.js first`);
	const ids = readFileSync(file, 'utf8').split('\n');
	if (ids.length - 1 < maxNFor(type)) throw new Error(`${file} has too few ids; delete cache/ and regenerate`);
	return ids;
}

// ---------------------------------------------------------------- measurements

// CPU reference: a fixed busy loop. Compare before/after (and across databases) to
// see whether the machine ran at the same speed for the whole run.
function calibrate() {
	const end = Date.now() + 3000;
	let n = 0;
	let x = 0;
	while (Date.now() < end) {
		for (let i = 0; i < 1e5; i++) x = (x * 1103515245 + 12345) >>> 0;
		n += 1e5;
	}
	return Math.round(n / 3 / 1e6); // million iterations per second
}

async function insertAll(conn, table, spec, ids, n) {
	// Batch size shrinks for tiny tables so there are still 10 slices to report.
	const batch = Math.max(1, Math.min(BATCH, Math.floor(n / 10)));
	const sliceSize = n / 10;
	const slices = [];
	let nextSlice = sliceSize;
	let sliceStart = process.hrtime.bigint();
	let sliceRows = 0;
	const t0 = sliceStart;
	for (let off = 0; off < n; off += batch) {
		const end = Math.min(off + batch, n);
		const users = Array.from({ length: end - off }, (_, j) => makeUser(off + j));
		await conn.insert(table, spec, ids ? ids.slice(off, end) : [], users);
		sliceRows += end - off;
		if (end >= nextSlice || end === n) {
			slices.push(Math.round(sliceRows / seconds(sliceStart)));
			sliceStart = process.hrtime.bigint();
			sliceRows = 0;
			nextSlice += sliceSize;
		}
	}
	const sec = seconds(t0);
	return { seconds: sec, rowsPerSec: Math.round(n / sec), batch, slices };
}

// Sequential point lookups for random existing rows on one connection.
async function lookups(conn, table, col, n, query) {
	const warmup = Math.min(1000, LOOKUPS);
	for (let k = 0; k < warmup; k++) await query(Math.floor(Math.random() * n));
	await conn.statsReset(table, col);
	const lat = new Float64Array(LOOKUPS);
	let misses = 0;
	const t0 = process.hrtime.bigint();
	for (let k = 0; k < LOOKUPS; k++) {
		const i = Math.floor(Math.random() * n);
		const s = process.hrtime.bigint();
		if ((await query(i)) !== 1) misses++;
		lat[k] = Number(process.hrtime.bigint() - s) / 1e3;
	}
	const sec = seconds(t0);
	const server = await conn.stats(table, col);
	lat.sort();
	return { qps: Math.round(LOOKUPS / sec), p50us: percentile(lat, 50), p95us: percentile(lat, 95), p99us: percentile(lat, 99), misses, server };
}

async function measure(conn, type, ids, n) {
	const spec = ID_TYPES[type];
	const table = `users_${type}`;
	await conn.setup(table, spec);
	const insert = await insertAll(conn, table, spec, ids, n);
	const size = await conn.size(table);
	const idOf = (i) => (spec.kind === 'db' ? String(i + 1) : ids[i]);
	const byId = await lookups(conn, table, 'id', n, (i) => conn.byId(table, spec, idOf(i)));
	const byEmail = await lookups(conn, table, 'email', n, (i) => conn.byEmail(table, emailOf(i)));
	await conn.drop(table);
	return { type, n, insert, size, byId, byEmail };
}

// Many connections inserting one row per statement (autocommit) into an empty table.
// Sequential IDs all land on the right-most index page; this is where that can hurt.
async function concurrentInsert(type, ids) {
	const spec = ID_TYPES[type];
	const table = `users_${type}`;
	const setupConn = await adapter.open();
	await setupConn.setup(table, spec);
	const conns = await Promise.all(Array.from({ length: CONC_WORKERS }, () => adapter.open()));
	const t0 = process.hrtime.bigint();
	await Promise.all(conns.map(async (c, w) => {
		for (let i = w; i < CONC_ROWS; i += CONC_WORKERS) await c.insert(table, spec, ids ? [ids[i]] : [], [makeUser(i)]);
	}));
	const sec = seconds(t0);
	await Promise.all(conns.map((c) => c.close()));
	await setupConn.drop(table);
	await setupConn.close();
	return { type, workers: CONC_WORKERS, rows: CONC_ROWS, seconds: sec, rowsPerSec: Math.round(CONC_ROWS / sec) };
}

// ---------------------------------------------------------------- main

mkdirSync(`results/${RUN_ID}`, { recursive: true });
const outFile = `results/${RUN_ID}/${adapter.name}.json`;
const types = TYPES.filter((t) => adapter.supports(ID_TYPES[t]));
const conn = await adapter.open();
const result = {
	db: adapter.name,
	env: await conn.init(),
	config: { sizes: SIZES, bigN: BIG_N, bigTypes: BIG_TYPES, batch: BATCH, lookups: LOOKUPS, cacheMb: CACHE_MB, concWorkers: CONC_WORKERS, concRows: CONC_ROWS },
	generation: existsSync('cache/meta.json') ? JSON.parse(readFileSync('cache/meta.json', 'utf8')) : {},
	calibration: { before: calibrate() },
	runs: [],
	concurrent: [],
	startedAt: new Date().toISOString(),
};
const save = () => writeFileSync(outFile, JSON.stringify(result, null, 2));
log(result.env.version, `| cache ${result.env.cache} | cpu ref ${result.calibration.before} M/s`);

for (const type of types) {
	const ids = loadIds(type);
	for (const n of SIZES.filter((n) => typesFor(n).includes(type))) {
		const r = await measure(conn, type, ids, n);
		result.runs.push(r);
		save();
		const srv = (x) => (x.server ? ` (server ${x.server.serverUs.toFixed(0)}µs, ${x.server.readsPerCall.toFixed(2)} reads)` : '');
		log(`${type} n=${n}: insert ${r.insert.rowsPerSec}/s (${r.insert.slices[0]} → ${r.insert.slices.at(-1)}), ` +
			`${((r.size.tableBytes + r.size.indexBytes) / 2 ** 20).toFixed(1)} MiB, ` +
			`id p50 ${r.byId.p50us.toFixed(0)}µs${srv(r.byId)}, email p50 ${r.byEmail.p50us.toFixed(0)}µs${srv(r.byEmail)}` +
			(r.byId.misses + r.byEmail.misses ? `  !! ${r.byId.misses + r.byEmail.misses} misses` : ''));
	}
	if (CONC_WORKERS > 0 && adapter.concurrent !== false) {
		const c = await concurrentInsert(type, ids);
		result.concurrent.push(c);
		save();
		log(`${type} concurrent x${c.workers}: ${c.rowsPerSec}/s`);
	}
}

// Re-run the first type's largest run up to 1M rows, to check that the machine did not
// drift between the start and the end of the run.
const first = result.runs.filter((r) => r.type === result.runs[0]?.type && r.n <= 1_000_000).at(-1);
if (first) {
	const again = await measure(conn, first.type, loadIds(first.type), first.n);
	result.recheck = { type: first.type, n: first.n, firstRowsPerSec: first.insert.rowsPerSec, againRowsPerSec: again.insert.rowsPerSec };
}
result.calibration.after = calibrate();
result.finishedAt = new Date().toISOString();
save();
await conn.close();
log(`done: cpu ref ${result.calibration.before} → ${result.calibration.after} M/s, saved ${outFile}`);
