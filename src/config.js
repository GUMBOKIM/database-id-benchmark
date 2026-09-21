// All knobs come from environment variables so bench.sh can pass them into the
// runner container unchanged. Defaults are the "full" run described in README.
import { ID_TYPES } from './ids.js';

const list = (v, d) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : d);
const num = (v, d) => (v ? Number(v) : d);

export const SIZES = list(process.env.SIZES, ['10', '100', '1000', '10000', '100000', '1000000', '10000000']).map(Number);
export const TYPES = list(process.env.TYPES, Object.keys(ID_TYPES));
// Row counts at or above BIG_N only run these types, to keep a full run to a few hours.
export const BIG_N = num(process.env.BIG_N, 10_000_000);
export const BIG_TYPES = list(process.env.BIG_TYPES, ['autoinc', 'uuidv4', 'uuidv7', 'ulid', 'cuid2']);
export const BATCH = num(process.env.BATCH, 1000);
export const LOOKUPS = num(process.env.LOOKUPS, 20_000);
export const CACHE_MB = num(process.env.CACHE_MB, 256);
// Concurrent single-row inserts: CONC_WORKERS connections share CONC_ROWS rows. 0 disables.
export const CONC_WORKERS = num(process.env.CONC_WORKERS, 16);
export const CONC_ROWS = num(process.env.CONC_ROWS, 100_000);
export const RUN_ID = process.env.RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');

export const typesFor = (n) => TYPES.filter((t) => n < BIG_N || BIG_TYPES.includes(t));
export const maxNFor = (type) => Math.max(...SIZES.filter((n) => typesFor(n).includes(type)), CONC_ROWS);
