// Usage: node src/report.js results/<RUN_ID>
// Reads every <db>.r<rep>.json in the run folder and writes
//   summary.csv  - one row per db × type × rep × checkpoint
//   report.html  - log10(N) charts per db, median over repetitions (band = min..max)
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ID_TYPES } from './ids.js';

const dir = process.argv[2] ?? `results/${readdirSync('results').filter((d) => !d.startsWith('_')).sort().at(-1)}`;
const files = readdirSync(dir).filter((f) => /\.r\d+\.json$/.test(f)).sort();
const runs = files.map((f) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')));
if (!runs.length) throw new Error(`no <db>.r<rep>.json in ${dir}`);

// ---------------------------------------------------------------- metrics

// Server-side time when the database reports it: it leaves out the client round trip,
// which is the same for every ID type and hides the differences.
// WAL from runs before the per-backend counters was cluster-wide (autovacuum leaked in).
const backendWal = (x) => (x?.wal?.scope === 'backend' ? x.wal : null);

// group: section heading in the report. Metrics a run did not record (older runs, MySQL
// without cold runs, ...) simply have no points and are left out.
const METRICS = [
	{ group: '쓰기', key: 'single_server', title: '한 건 삽입: 서버 실행 시간 평균 (커밋 제외)', unit: 'µs', log: true, get: (p) => p.single.server?.serverUs },
	{ group: '쓰기', key: 'single_reads', title: '한 건 삽입: 건당 캐시 밖 읽기 (블록)', unit: '', log: false, get: (p) => p.single.server?.readsPerCall },
	{ group: '쓰기', key: 'single_p50', title: '한 건 삽입 지연 p50 (커밋 포함)', unit: 'µs', log: true, get: (p) => p.single.p50us },
	{ group: '쓰기', key: 'single_p99', title: '한 건 삽입 지연 p99 (커밋 포함)', unit: 'µs', log: true, get: (p) => p.single.p99us },
	{ group: '쓰기', key: 'bulk', title: '묶음 삽입 처리량 (참고)', unit: 'rows/s', log: true, get: (p) => p.bulk.rowsPerSec },
	{ group: '동시 삽입 (10만 건 이상, 10배 지점)', key: 'conc_tput', title: '동시 삽입 처리량', unit: 'rows/s', log: true, get: (p) => p.concurrent?.rowsPerSec },
	{ group: '동시 삽입 (10만 건 이상, 10배 지점)', key: 'conc_p99', title: '동시 삽입 지연 p99', unit: 'µs', log: true, get: (p) => p.concurrent?.p99us },
	{ group: '조회 (캐시 따뜻함)', key: 'uniform_server', title: 'ID 조회, 균등: 서버 실행 시간 평균', unit: 'µs', log: true, get: (p) => p.uniform.server?.serverUs },
	{ group: '조회 (캐시 따뜻함)', key: 'uniform_p50', title: 'ID 조회, 균등: 클라이언트 p50 (왕복 포함)', unit: 'µs', log: true, get: (p) => p.uniform.p50us },
	{ group: '조회 (캐시 따뜻함)', key: 'uniform_p99', title: 'ID 조회, 균등: 클라이언트 p99 (왕복 포함)', unit: 'µs', log: true, get: (p) => p.uniform.p99us },
	{ group: '조회 (캐시 따뜻함)', key: 'uniform_reads', title: 'ID 조회, 균등: 조회당 캐시 밖 읽기 (블록)', unit: '', log: false, get: (p) => p.uniform.server?.readsPerCall },
	{ group: '조회 (캐시 따뜻함)', key: 'recent_server', title: 'ID 조회, 최근 편중: 서버 실행 시간 평균', unit: 'µs', log: true, get: (p) => p.recent.server?.serverUs },
	{ group: '조회 (캐시 따뜻함)', key: 'recent_p50', title: 'ID 조회, 최근 편중: 클라이언트 p50 (왕복 포함)', unit: 'µs', log: true, get: (p) => p.recent.p50us },
	{ group: '조회 (캐시 따뜻함)', key: 'recent_p99', title: 'ID 조회, 최근 편중: 클라이언트 p99 (왕복 포함)', unit: 'µs', log: true, get: (p) => p.recent.p99us },
	{ group: '조회 (캐시 따뜻함)', key: 'recent_reads', title: 'ID 조회, 최근 편중: 조회당 캐시 밖 읽기 (블록)', unit: '', log: false, get: (p) => p.recent.server?.readsPerCall },
	{ group: '캐시를 비운 직후 (10배 지점)', key: 'cold_insert_server', title: '한 건 삽입: 서버 실행 시간 평균 (커밋 제외)', unit: 'µs', log: true, get: (p) => p.cold?.single.server?.serverUs },
	{ group: '캐시를 비운 직후 (10배 지점)', key: 'cold_insert_p50', title: '한 건 삽입 지연 p50 (커밋 포함)', unit: 'µs', log: true, get: (p) => p.cold?.single.p50us },
	{ group: '캐시를 비운 직후 (10배 지점)', key: 'cold_uniform_server', title: 'ID 조회, 균등: 서버 실행 시간 평균', unit: 'µs', log: true, get: (p) => p.cold?.uniform.server?.serverUs },
	{ group: '캐시를 비운 직후 (10배 지점)', key: 'cold_uniform_p99', title: 'ID 조회, 균등: 클라이언트 p99', unit: 'µs', log: true, get: (p) => p.cold?.uniform.p99us },
	{ group: '캐시를 비운 직후 (10배 지점)', key: 'cold_recent_server', title: 'ID 조회, 최근 편중: 서버 실행 시간 평균', unit: 'µs', log: true, get: (p) => p.cold?.recent.server?.serverUs },
	{ group: '캐시를 비운 직후 (10배 지점)', key: 'cold_recent_reads', title: 'ID 조회, 최근 편중: 조회당 캐시 밖 읽기 (블록)', unit: '', log: false, get: (p) => p.cold?.recent.server?.readsPerCall },
	{ group: 'WAL', key: 'single_wal_bytes', title: '한 건 삽입당 WAL', unit: 'B', log: true, get: (p) => backendWal(p.single)?.bytesPerRow },
	{ group: 'WAL', key: 'single_wal_fpi', title: '한 건 삽입당 전체 페이지 기록 (FPI)', unit: '', log: false, get: (p) => backendWal(p.single)?.fpiPerRow },
	{ group: 'WAL', key: 'bulk_wal_bytes', title: '묶음 삽입 행당 WAL', unit: 'B', log: true, get: (p) => backendWal(p.bulk)?.bytesPerRow },
	{ group: '용량', key: 'bytes_row', title: '행당 용량 (테이블 + 인덱스)', unit: 'B', log: false, get: (p) => (p.size.tableBytes + p.size.indexBytes) / p.n },
	{ group: '용량', key: 'table_row', title: '행당 테이블 용량', unit: 'B', log: false, get: (p) => p.size.tableBytes / p.n },
	{ group: '용량', key: 'index_row', title: '행당 인덱스 용량', unit: 'B', log: false, get: (p) => p.size.indexBytes / p.n },
	{ group: '용량', key: 'pk_density', title: 'PK 인덱스 리프 페이지 평균 채움률 (10배 지점)', unit: '%', log: false, get: (p) => p.index?.avgLeafDensity },
	{ group: '용량', key: 'pk_frag', title: 'PK 인덱스 리프 단편화 (10배 지점)', unit: '%', log: false, get: (p) => p.index?.leafFragmentation },
];

// A type whose run stopped before N_MAX (the process crashed) would pull the median
// around at the sizes it reached: leave it out entirely.
const complete = (run, type) => {
	const pts = run.types[type] ?? [];
	return pts.at(-1)?.n === run.config.checkpoints.at(-1) ? pts : [];
};
const skipped = runs.flatMap((r) => Object.keys(r.types).filter((t) => !complete(r, t).length).map((t) => `${r.db} r${r.rep} ${t}`));
if (skipped.length) console.log(`left out, incomplete: ${skipped.join(', ')}`);

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// data[db][metric][type] = [{ n, med, min, max, reps }]
const data = {};
const meta = {};
for (const run of runs) {
	meta[run.db] ??= { env: run.env, config: run.config, reps: [], calibration: [] };
	meta[run.db].reps.push(run.rep);
	meta[run.db].calibration.push({ rep: run.rep, ...run.calibration });
}
for (const db of Object.keys(meta)) {
	data[db] = {};
	const mine = runs.filter((r) => r.db === db);
	for (const m of METRICS) {
		data[db][m.key] = {};
		for (const type of Object.keys(ID_TYPES)) {
			const byN = new Map();
			for (const run of mine) for (const p of complete(run, type)) {
				const v = m.get(p);
				if (v == null || !Number.isFinite(v)) continue;
				if (!byN.has(p.n)) byN.set(p.n, []);
				byN.get(p.n).push(v);
			}
			if (!byN.size) continue;
			data[db][m.key][type] = [...byN].sort((a, b) => a[0] - b[0])
				.map(([n, vs]) => ({ n, med: median(vs), min: Math.min(...vs), max: Math.max(...vs), reps: vs.length }));
		}
	}
}

// ---------------------------------------------------------------- csv

const csv = [['db', 'rep', 'type', 'n', 'bulk_rows_per_sec', 'insert_p50_us', 'insert_p95_us', 'insert_p99_us', 'insert_server_us', 'insert_reads_per_call', 'table_bytes', 'index_bytes',
	'uniform_p50_us', 'uniform_p99_us', 'uniform_server_us', 'uniform_reads_per_call',
	'recent_p50_us', 'recent_p99_us', 'recent_server_us', 'recent_reads_per_call', 'misses',
	'insert_wal_bytes', 'insert_wal_fpi', 'bulk_wal_bytes', 'pk_leaf_density', 'pk_leaf_fragmentation',
	'conc_rows_per_sec', 'conc_p99_us', 'cold_insert_p50_us', 'cold_insert_server_us',
	'cold_uniform_p50_us', 'cold_uniform_server_us', 'cold_recent_p50_us', 'cold_recent_server_us'].join(',')];
const f1 = (x) => (x == null ? '' : x.toFixed(1));
const f3 = (x) => (x == null ? '' : x.toFixed(3));
for (const run of runs) {
	for (const [type, points] of Object.entries(run.types)) {
		for (const p of points) {
			csv.push([run.db, run.rep, type, p.n, p.bulk.rowsPerSec ?? '', f1(p.single.p50us), f1(p.single.p95us), f1(p.single.p99us), f1(p.single.server?.serverUs), f3(p.single.server?.readsPerCall),
				p.size.tableBytes, p.size.indexBytes,
				f1(p.uniform.p50us), f1(p.uniform.p99us), f1(p.uniform.server?.serverUs), f3(p.uniform.server?.readsPerCall),
				f1(p.recent.p50us), f1(p.recent.p99us), f1(p.recent.server?.serverUs), f3(p.recent.server?.readsPerCall),
				p.uniform.misses + p.recent.misses,
				f1(p.single.wal?.bytesPerRow), f3(p.single.wal?.fpiPerRow), f1(p.bulk.wal?.bytesPerRow), f1(p.index?.avgLeafDensity), f1(p.index?.leafFragmentation),
				p.concurrent?.rowsPerSec ?? '', f1(p.concurrent?.p99us), f1(p.cold?.single.p50us), f1(p.cold?.single.server?.serverUs),
				f1(p.cold?.uniform.p50us), f1(p.cold?.uniform.server?.serverUs), f1(p.cold?.recent.p50us), f1(p.cold?.recent.server?.serverUs)].join(','));
		}
	}
}
writeFileSync(`${dir}/summary.csv`, csv.join('\n') + '\n');

// ---------------------------------------------------------------- html

const TYPES = Object.fromEntries(Object.entries(ID_TYPES).map(([k, v]) => [k, { label: v.label, sorted: v.sorted, kind: v.kind }]));
const payload = { run: dir.split('/').at(-1), metrics: METRICS.map(({ get, ...m }) => m), data, meta, types: TYPES, generation: runs[0].generation ?? {} };
const html = readFileSync(new URL('./report-template.html', import.meta.url), 'utf8')
	.replace('/*__DATA__*/null', JSON.stringify(payload).replace(/</g, '\\u003c'));
writeFileSync(`${dir}/report.html`, html);
console.log(`wrote ${dir}/summary.csv and ${dir}/report.html (${files.length} run files)`);
