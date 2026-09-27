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
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ID_TYPES, emailOf, accountOf, phoneOf } from './ids.js';
import {
	TYPES, CHECKPOINTS, BATCH, SINGLE_W, READ_N, READ_WARMUP, RECENT_FRAC, RECENT_SHARE,
	RUN_ID, REP, N_MIN, N_MAX, POINTS_PER_DECADE,
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
	if (ids.length - 1 < N_MAX) throw new Error(`${file} has too few ids; delete cache/ and regenerate`);
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

async function bulkLoad(conn, table, spec, ids, from, to) {
	const t0 = process.hrtime.bigint();
	for (let off = from; off < to; off += BATCH) {
		const end = Math.min(off + BATCH, to);
		const users = Array.from({ length: end - off }, (_, j) => makeUser(off + j));
		await conn.insert(table, spec, ids ? ids.slice(off, end) : [], users);
	}
	const sec = seconds(t0);
	return { rows: to - from, seconds: sec, rowsPerSec: to > from ? Math.round((to - from) / sec) : null };
}

async function singleInserts(conn, table, spec, ids, from, to) {
	await conn.statsReset(table, 'insert');
	const lat = new Float64Array(to - from);
	for (let i = from; i < to; i++) {
		const user = makeUser(i);
		const s = process.hrtime.bigint();
		await conn.insertOne(table, spec, ids ? ids[i] : null, user);
		lat[i - from] = Number(process.hrtime.bigint() - s) / 1e3;
	}
	return { ...percentiles(lat), server: await conn.stats(table, 'insert') };
}

// Sequential point lookups by id on one connection. pick() returns a row index.
async function lookups(conn, table, pick, query) {
	for (let k = 0; k < READ_WARMUP; k++) await query(pick());
	await conn.statsReset(table, 'select');
	const lat = new Float64Array(READ_N);
	let misses = 0;
	const t0 = process.hrtime.bigint();
	for (let k = 0; k < READ_N; k++) {
		const i = pick();
		const s = process.hrtime.bigint();
		if ((await query(i)) !== 1) misses++;
		lat[k] = Number(process.hrtime.bigint() - s) / 1e3;
	}
	const sec = seconds(t0);
	const server = await conn.stats(table, 'select');
	return { qps: Math.round(READ_N / sec), ...percentiles(lat), misses, server };
}

async function growAndMeasure(conn, type, ids) {
	const spec = ID_TYPES[type];
	const table = `users_${type}`;
	const idOf = (i) => (spec.kind === 'db' ? String(i + 1) : ids[i]);
	const query = (i) => conn.byId(table, spec, idOf(i));
	await conn.setup(table, spec);
	let filled = 0;
	for (const n of CHECKPOINTS) {
		const w = Math.min(SINGLE_W, n - filled);
		const bulk = await bulkLoad(conn, table, spec, ids, filled, n - w);
		const single = await singleInserts(conn, table, spec, ids, n - w, n);
		filled = n;
		const size = await conn.size(table);
		const uniform = await lookups(conn, table, () => Math.floor(Math.random() * n), query);
		const recentFrom = n - Math.max(1, Math.ceil(n * RECENT_FRAC));
		const recent = await lookups(conn, table, () => (Math.random() < RECENT_SHARE
			? recentFrom + Math.floor(Math.random() * (n - recentFrom))
			: Math.floor(Math.random() * recentFrom)), query);
		record(type, { n, bulk, single, size, uniform, recent });
	}
	await conn.drop(table);
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
}

for (const type of TYPES) {
	const t0 = process.hrtime.bigint();
	await growAndMeasure(conn, type, loadIds(type));
	log(`${type} done in ${(seconds(t0) / 60).toFixed(1)} min`);
}

result.calibration.after = calibrate();
result.finishedAt = new Date().toISOString();
save();
await conn.close();
log(`done: cpu ref ${result.calibration.before} → ${result.calibration.after} M/s, saved ${outFile}`);
