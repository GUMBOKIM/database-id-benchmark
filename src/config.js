// All knobs come from environment variables so bench.sh can pass them into the
// runner container unchanged. Defaults are the "full" run described in README.

const list = (v, d) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : d);
const num = (v, d) => (v ? Number(v) : d);

// The widely used ones. src/ids.js has more (uuidv1/v6, uuidv4_str, typeid, ...) for TYPES=.
export const TYPES = list(process.env.TYPES, ['autoinc', 'snowflake', 'uuidv4', 'uuidv7', 'ulid', 'nanoid', 'cuid2']);
// Simulated sign-up clock for time-based IDs: N_MAX users arrive over SIM_DAYS days
// (exponential gaps), starting 2025-01-01 UTC.
export const SIM_DAYS = num(process.env.SIM_DAYS, 365);
export const SIM_START_MS = Date.UTC(2025, 0, 1);
export const SIM_CLOCK_TAG = `${SIM_DAYS}d@${SIM_START_MS}`;
// Returns successive sign-up times (ms): row 0, row 1, ... Same seed every time, so gen.js
// and bench.js (which continues it past N_MAX for the cold-cache rows) agree.
export function simClock() {
	let s = 42;
	const rand = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
	const meanGap = (SIM_DAYS * 86_400_000) / N_MAX;
	let t = SIM_START_MS;
	return () => { t += -Math.log(1 - rand()) * meanGap; return Math.floor(t); };
}
// One table per ID type grows from empty to N_MAX; it is measured at POINTS_PER_DECADE
// log-spaced row counts (1000, 1260, 1580, 2000, ... with the default 10).
export const N_MIN = num(process.env.N_MIN, 1000);
export const N_MAX = num(process.env.N_MAX, 10_000_000);
export const POINTS_PER_DECADE = num(process.env.POINTS_PER_DECADE, 10);
// Rows between checkpoints are bulk-loaded BATCH at a time, except the last SINGLE_W
// before each checkpoint, which go in one row per statement (autocommit) and are timed.
export const BATCH = num(process.env.BATCH, 1000);
export const SINGLE_W = num(process.env.SINGLE_W, 1000);
// Point lookups by id at every checkpoint, once per access pattern (uniform, recent).
export const READ_N = num(process.env.READ_N, 5000);
export const READ_WARMUP = num(process.env.READ_WARMUP, 500);
// "recent": RECENT_SHARE of lookups hit the newest RECENT_FRAC of rows.
export const RECENT_FRAC = num(process.env.RECENT_FRAC, 0.1);
export const RECENT_SHARE = num(process.env.RECENT_SHARE, 0.9);
// Cold cache, at every power of ten: shared_buffers and the OS page cache are emptied
// before COLD_W single-row inserts and before each COLD_READ_N-lookup pattern.
export const COLD_W = num(process.env.COLD_W, 200);
export const COLD_READ_N = num(process.env.COLD_READ_N, 1000);
// Concurrent inserts at powers of ten >= CONC_MIN_N: CONC_WORKERS connections insert
// CONC_ROWS rows one per statement. CONC_WORKERS=0 disables.
export const CONC_WORKERS = num(process.env.CONC_WORKERS, 16);
export const CONC_ROWS = num(process.env.CONC_ROWS, 8000);
export const CONC_MIN_N = num(process.env.CONC_MIN_N, 100_000);
export const RUN_ID = process.env.RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
export const REP = num(process.env.REP, 1);

// 3 significant digits keeps the points readable: 10^(31/10) = 1258.9 -> 1260.
const round3 = (x) => { const p = 10 ** (Math.floor(Math.log10(x)) - 2); return Math.round(x / p) * p; };
export const CHECKPOINTS = (() => {
	const out = [];
	for (let k = Math.ceil(Math.log10(N_MIN) * POINTS_PER_DECADE - 1e-9); ; k++) {
		const n = round3(10 ** (k / POINTS_PER_DECADE));
		if (n > N_MAX) break;
		if (n >= N_MIN && n !== out.at(-1)) out.push(n);
	}
	return out;
})();
