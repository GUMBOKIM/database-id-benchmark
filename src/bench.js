// Grows one table per ID type from empty to N_MAX against ONE database, inside the
// runner container, and measures it at every checkpoint (config.js CHECKPOINTS).
// Usage (normally via bench.sh): node src/bench.js <db>
// Writes results/<RUN_ID>/<db>.r<REP>.json after every checkpoint, so a crash keeps what ran.
//
// At each checkpoint N:
//   1. bulk-load up to N - SINGLE_W (BATCH rows per statement; throughput kept for reference)
//   2. insert the last SINGLE_W rows one per statement, autocommit, and time each one
//   3. table / index size
//   4. READ_N lookups by id, uniform over all rows
//   5. READ_N lookups by id, RECENT_SHARE of them in the newest RECENT_FRAC of rows
// WAL written is recorded for 1 and 2. At powers of ten, also:
//   - CONC_ROWS single-row inserts from CONC_WORKERS connections at once (N >= CONC_MIN_N),
//     just before step 2
//   - primary-key B-tree stats (pgstatindex)
//   - after everything above, so the warm numbers are untouched: COLD_W single-row
//     inserts (rows N.. onwards) right after emptying shared_buffers and the OS page cache,
//     then COLD_READ_N lookups per pattern, each right after emptying the caches again;
//     finally the table and indexes are read back into the OS page cache
// ID types run in a different order in every repetition (seeded by REP), so drift over
// the run (disk, temperature) does not always land on the same types.
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ID_TYPES, emailOf, accountOf, phoneOf } from './ids.js';
import {
	TYPES, CHECKPOINTS, BATCH, SINGLE_W, READ_N, READ_WARMUP, RECENT_FRAC, RECENT_SHARE,
	RUN_ID, REP, N_MIN, N_MAX, POINTS_PER_DECADE,
	COLD_W, COLD_READ_N, CONC_WORKERS, CONC_ROWS, CONC_MIN_N, SIM_DAYS, simClock,
} from './config.js';
import postgres from './adapters/postgres.js';
import { mysqlAdapter, mariadbAdapter } from './adapters/mysql.js';

const ADAPTERS = { postgres, mysql: mysqlAdapter, mariadb: mariadbAdapter };
const adapter = ADAPTERS[process.argv[2]];
if (!adapter) throw new Error(`usage: node src/bench.js <${Object.keys(ADAPTERS).join('|')}>`);

const log = (...m) => console.log(new Date().toISOString().slice(11, 19), `[${adapter.name}]`, ...m);
const seconds = (t0) => Number(process.hrtime.bigint() - t0) / 1e9;
const percentiles = (lat) => {
	lat.sort();
	const at = (p) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))];
	return { count: lat.length, p50us: at(50), p95us: at(95), p99us: at(99), maxus: lat.at(-1) };
};

// ---------------------------------------------------------------- data

const NAMES = ['김민준', '이서연', '박지호', '최유나', '정하윤', '강도윤', '조서준', '윤지우', '장예준', '임수아'];
const makeUser = (i) => ({
	account: accountOf(i),
	passwordHash: `$2b$10$${randomBytes(40).toString('base64').replace(/[+/=]/g, 'x').slice(0, 53)}`,
	name: NAMES[i % NAMES.length],
	phone: phoneOf(i),
	email: emailOf(i),
});

// IDs come from cache/<type>.txt (src/gen.js), one type in memory at a time.
function loadIds(type) {
	if (ID_TYPES[type].kind === 'db') return null;
	const file = `cache/${type}.txt`;
	if (!existsSync(file)) throw new Error(`${file} missing; run src/gen.js first`);
	const ids = readFileSync(file, 'utf8').split('\n');
	ids.pop(); // trailing newline
	if (ids.length < N_MAX) throw new Error(`${file} has too few ids; delete cache/ and regenerate`);
	// The cold-cache inserts at N_MAX go past it: make those few IDs here, continuing the
	// same sign-up clock gen.js used, so they come after every cached ID.
	const now = simClock();
	for (let i = 0; i < N_MAX; i++) now();
	// Two rows can land in the same millisecond; never repeat a cached ID.
	const tail = new Set(ids.slice(-1000));
	while (ids.length < N_MAX + COLD_W) {
		let t = now();
		let id;
		do id = ID_TYPES[type].gen(ids.length, t++); while (tail.has(id));
		ids.push(id);
	}
	return ids;
}

// ---------------------------------------------------------------- measurements

// CPU reference: a fixed busy loop. Compare before/after to see whether the machine
// ran at the same speed for the whole run.
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

// WAL written between two conn.wal() snapshots, per row.
const walPer = (a, b, rows) => (rows > 0 ? {
	scope: b.scope,
	bytesPerRow: (b.bytes - a.bytes) / rows,
	fpiPerRow: b.fpi == null ? null : (b.fpi - a.fpi) / rows,
	recordsPerRow: b.records == null ? null : (b.records - a.records) / rows,
} : null);

async function bulkLoad(conn, table, spec, ids, from, to) {
	const w0 = await conn.wal();
	const t0 = process.hrtime.bigint();
	for (let off = from; off < to; off += BATCH) {
		const end = Math.min(off + BATCH, to);
		const users = Array.from({ length: end - off }, (_, j) => makeUser(off + j));
		await conn.insert(table, spec, ids ? ids.slice(off, end) : [], users);
	}
	const sec = seconds(t0);
	return { rows: to - from, seconds: sec, rowsPerSec: to > from ? Math.round((to - from) / sec) : null, wal: walPer(w0, await conn.wal(), to - from) };
}

async function singleInserts(conn, table, spec, ids, from, to) {
	await conn.statsReset(table, 'insert');
	const w0 = await conn.wal();
	const lat = new Float64Array(to - from);
	for (let i = from; i < to; i++) {
		const user = makeUser(i);
		const s = process.hrtime.bigint();
		await conn.insertOne(table, spec, ids ? ids[i] : null, user);
		lat[i - from] = Number(process.hrtime.bigint() - s) / 1e3;
	}
	const server = await conn.stats(table, 'insert');
	return { ...percentiles(lat), server, wal: walPer(w0, await conn.wal(), to - from) };
}

// CONC_WORKERS connections insert rows from..to-1, one per statement, all at once.
async function concurrentInserts(conns, table, spec, ids, from, to) {
	const lat = new Float64Array(to - from);
	const walAll = async () => (await Promise.all(conns.map((c) => c.wal()))).reduce((a, b) => ({ bytes: a.bytes + b.bytes, fpi: a.fpi == null ? null : a.fpi + b.fpi, records: a.records == null ? null : a.records + b.records }));
	const w0 = await walAll();
	const t0 = process.hrtime.bigint();
	await Promise.all(conns.map(async (c, w) => {
		for (let i = from + w; i < to; i += conns.length) {
			const user = makeUser(i);
			const s = process.hrtime.bigint();
			await c.insertOne(table, spec, ids ? ids[i] : null, user);
			lat[i - from] = Number(process.hrtime.bigint() - s) / 1e3;
		}
	}));
	const sec = seconds(t0);
	return { workers: conns.length, rows: to - from, rowsPerSec: Math.round((to - from) / sec), ...percentiles(lat), wal: walPer(w0, await walAll(), to - from) };
}

// Empty shared_buffers and the OS page cache. The OS part needs the runner to be
// privileged (docker-compose.yml); without it only shared_buffers is emptied.
let osDropWarned = false;
async function dropCaches(conn) {
	await conn.evict();
	try {
		execSync('sync');
		writeFileSync('/proc/sys/vm/drop_caches', '3');
		return true;
	} catch (e) {
		if (!osDropWarned) { log(`!! cannot drop the OS page cache (${e.code ?? e.message}); cold runs keep it`); osDropWarned = true; }
		return false;
	}
}

// Sequential point lookups by id on one connection. pick() returns a row index.
async function lookups(conn, table, pick, query, count = READ_N, warmup = READ_WARMUP) {
	for (let k = 0; k < warmup; k++) await query(pick());
	await conn.statsReset(table, 'select');
	const lat = new Float64Array(count);
	let misses = 0;
	const t0 = process.hrtime.bigint();
	for (let k = 0; k < count; k++) {
		const i = pick();
		const s = process.hrtime.bigint();
		if ((await query(i)) !== 1) misses++;
		lat[k] = Number(process.hrtime.bigint() - s) / 1e3;
	}
	const sec = seconds(t0);
	const server = await conn.stats(table, 'select');
	return { qps: Math.round(count / sec), ...percentiles(lat), misses, server };
}

const isDecade = (n) => Number.isInteger(Math.log10(n));

async function growAndMeasure(conn, type, ids) {
	const spec = ID_TYPES[type];
	const table = `users_${type}`;
	const idOf = (i) => (spec.kind === 'db' ? String(i + 1) : ids[i]);
	const query = (i) => conn.byId(table, spec, idOf(i));
	const uniformPick = (n) => () => Math.floor(Math.random() * n);
	const recentPick = (n) => {
		const from = n - Math.max(1, Math.ceil(n * RECENT_FRAC));
		return () => (Math.random() < RECENT_SHARE ? from + Math.floor(Math.random() * (n - from)) : Math.floor(Math.random() * from));
	};
	const canCold = typeof conn.evict === 'function';
	await conn.setup(table, spec);
	const conns = CONC_WORKERS > 0 ? await Promise.all(Array.from({ length: CONC_WORKERS }, () => adapter.open())) : [];
	let filled = 0;
	for (const n of CHECKPOINTS) {
		// Rows filled on the way to n: bulk, then (at powers of ten) concurrent inserts,
		// then the timed warm single-row inserts right before n. Cold-cache inserts come
		// after all warm measurements and add rows n, n+1, ... (the next bulk load skips them).
		const decade = isDecade(n);
		const concRows = decade && conns.length && n >= CONC_MIN_N ? CONC_ROWS : 0;
		const w = Math.min(SINGLE_W, n - filled - concRows);
		let at = n - w - concRows;
		const p = { n };
		p.bulk = await bulkLoad(conn, table, spec, ids, filled, at);
		if (concRows) { p.concurrent = await concurrentInserts(conns, table, spec, ids, at, at + concRows); at += concRows; }
		p.single = await singleInserts(conn, table, spec, ids, at, n);
		filled = n;
		p.size = await conn.size(table);
		if (decade) p.index = await conn.indexStats(table);
		p.uniform = await lookups(conn, table, uniformPick(n), query);
		p.recent = await lookups(conn, table, recentPick(n), query);
		if (decade && canCold) {
			p.cold = { osCacheDropped: await dropCaches(conn) };
			p.cold.single = await singleInserts(conn, table, spec, ids, n, n + COLD_W);
			filled = n + COLD_W;
			await dropCaches(conn);
			p.cold.uniform = await lookups(conn, table, uniformPick(n), query, COLD_READ_N, 0);
			await dropCaches(conn);
			p.cold.recent = await lookups(conn, table, recentPick(n), query, COLD_READ_N, 0);
			await conn.warm(table);
		}
		record(type, p);
	}
	await Promise.all(conns.map((c) => c.close()));
	await conn.drop(table);
}

// Same seed, same order: rep 1 shuffles one way, rep 2 another.
function shuffled(list, seed) {
	let s = seed * 0x9e3779b1;
	const rand = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
	const a = [...list];
	for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
	return a;
}

// ---------------------------------------------------------------- main

mkdirSync(`results/${RUN_ID}`, { recursive: true });
const outFile = `results/${RUN_ID}/${adapter.name}.r${REP}.json`;
const conn = await adapter.open();
const result = {
	db: adapter.name,
	rep: REP,
	env: await conn.init(),
	config: {
		types: TYPES, nMin: N_MIN, nMax: N_MAX, pointsPerDecade: POINTS_PER_DECADE, checkpoints: CHECKPOINTS,
		batch: BATCH, singleW: SINGLE_W, readN: READ_N, readWarmup: READ_WARMUP,
		recentFrac: RECENT_FRAC, recentShare: RECENT_SHARE,
		coldW: COLD_W, coldReadN: COLD_READ_N, concWorkers: CONC_WORKERS, concRows: CONC_ROWS, concMinN: CONC_MIN_N, simDays: SIM_DAYS,
	},
	generation: existsSync('cache/meta.json') ? JSON.parse(readFileSync('cache/meta.json', 'utf8')) : {},
	calibration: { before: calibrate() },
	types: {},
	startedAt: new Date().toISOString(),
};
const save = () => writeFileSync(outFile, JSON.stringify(result, null, 2));
log(result.env.version.split(' ').slice(0, 2).join(' '), `| cache ${result.env.cache} | cpu ref ${result.calibration.before} M/s | ${CHECKPOINTS.length} checkpoints to ${N_MAX}`);

// Called after every checkpoint: save and print one line.
function record(type, p) {
	(result.types[type] ??= []).push(p);
	save();
	const mib = (p.size.tableBytes + p.size.indexBytes) / 2 ** 20;
	const srv = (x) => (x.server ? `/${x.server.serverUs.toFixed(0)}µs ${x.server.readsPerCall.toFixed(2)}rd` : '');
	log(`${type} n=${p.n}: bulk ${p.bulk.rowsPerSec ?? '-'}/s, insert p50 ${p.single.p50us.toFixed(0)} p99 ${p.single.p99us.toFixed(0)}µs${srv(p.single)}, ` +
		`${mib.toFixed(1)} MiB, uniform p50 ${p.uniform.p50us.toFixed(0)}µs${srv(p.uniform)}, recent p50 ${p.recent.p50us.toFixed(0)}µs${srv(p.recent)}` +
		(p.uniform.misses + p.recent.misses ? `  !! ${p.uniform.misses + p.recent.misses} misses` : ''));
	if (p.single.wal) log(`${type} n=${p.n}: wal ${p.single.wal.bytesPerRow.toFixed(0)} B/insert, ${p.single.wal.fpiPerRow?.toFixed(2) ?? '-'} fpi/insert` +
		(p.index ? `, pk leaf density ${p.index.avgLeafDensity.toFixed(1)}% frag ${p.index.leafFragmentation.toFixed(1)}%` : '') +
		(p.concurrent ? `, concurrent x${p.concurrent.workers} ${p.concurrent.rowsPerSec}/s p99 ${p.concurrent.p99us.toFixed(0)}µs` : '') +
		(p.cold ? `, cold${p.cold.osCacheDropped ? '' : '(buffers only)'} insert p50 ${p.cold.single.p50us.toFixed(0)}µs uniform p50 ${p.cold.uniform.p50us.toFixed(0)}µs recent p50 ${p.cold.recent.p50us.toFixed(0)}µs` : ''));
}

const order = shuffled(TYPES, REP);
result.order = order;
log(`order: ${order.join(' ')}`);
for (const type of order) {
	const t0 = process.hrtime.bigint();
	await growAndMeasure(conn, type, loadIds(type));
	log(`${type} done in ${(seconds(t0) / 60).toFixed(1)} min`);
}

result.calibration.after = calibrate();
result.finishedAt = new Date().toISOString();
save();
await conn.close();
log(`done: cpu ref ${result.calibration.before} → ${result.calibration.after} M/s, saved ${outFile}`);
