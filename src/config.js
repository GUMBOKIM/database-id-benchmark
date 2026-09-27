// All knobs come from environment variables so bench.sh can pass them into the
// runner container unchanged. Defaults are the "full" run described in README.

const list = (v, d) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : d);
const num = (v, d) => (v ? Number(v) : d);

export const TYPES = list(process.env.TYPES, [
	'autoinc', 'snowflake', 'uuidv1', 'uuidv4', 'uuidv6', 'uuidv7',
	'uuidv4_str', 'ulid', 'objectid', 'typeid', 'nanoid', 'cuid2',
]);
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
