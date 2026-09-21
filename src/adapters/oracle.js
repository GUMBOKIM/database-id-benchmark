// Oracle Database Free (23ai / 26ai). Tables live in the BENCH app user's schema;
// a separate SYSTEM connection reads v$sql for server-side timings.
import oracledb from 'oracledb';
import { CACHE_MB } from '../config.js';
import { uuidBytes } from '../ids.js';

oracledb.autoCommit = true;
oracledb.fetchAsBuffer = [oracledb.BLOB];

const connectString = 'oracle:1521/FREEPDB1';
const column = (spec) => {
	switch (spec.kind) {
		case 'db': return 'number(19) generated always as identity';
		case 'int': return 'number(19)';
		case 'uuid': return 'raw(16)'; // no uuid type; RAW(16) is the usual choice
		default: return `varchar2(${spec.len})`;
	}
};
const toDb = (spec, id) => (spec.kind === 'uuid' ? uuidBytes(id) : id);
const byIdSql = (table) => `select * from ${table} where id = :1`;
const byEmailSql = (table) => `select * from ${table} where email = :1`;

async function open() {
	const conn = await oracledb.getConnection({ user: 'bench', password: 'bench', connectString });
	const admin = await oracledb.getConnection({ user: 'system', password: 'bench', connectString });
	let before = {};

	// Cumulative v$sql counters for one statement text; stats() diffs two snapshots.
	async function snapshot(sqlText) {
		const r = await admin.execute(
			`select nvl(sum(executions),0) as e, nvl(sum(elapsed_time),0) as t, nvl(sum(disk_reads),0) as d, nvl(sum(buffer_gets),0) as b
			 from v$sql where parsing_schema_name = 'BENCH' and sql_text = :1`, [sqlText], { outFormat: oracledb.OUT_FORMAT_OBJECT });
		const row = r.rows[0];
		return { e: Number(row.E), t: Number(row.T), d: Number(row.D), b: Number(row.B) };
	}
	const sqlFor = (table, col) => (col === 'id' ? byIdSql(table) : byEmailSql(table));

	return {
		async init() {
			const v = await admin.execute(`select banner_full from v$version`);
			const c = await admin.execute(`select value from v$parameter where name = 'db_cache_size'`);
			return { version: v.rows[0][0], cache: `${Number(c.rows[0][0]) / 2 ** 20}MB`, cacheMb: CACHE_MB };
		},

		async setup(table, spec) {
			await conn.execute(`begin execute immediate 'drop table ${table} purge'; exception when others then null; end;`);
			await conn.execute(`
				create table ${table} (
					id ${column(spec)} primary key,
					email varchar2(255) not null unique,
					name varchar2(100) not null,
					password_hash varchar2(255) not null,
					status varchar2(20) default 'active' not null,
					created_at timestamp with time zone default systimestamp not null,
					updated_at timestamp with time zone default systimestamp not null
				)`);
			await conn.execute(`create index ${table}_ca on ${table} (created_at)`);
		},

		async insert(table, spec, ids, users) {
			if (spec.kind === 'db') {
				await conn.executeMany(`insert into ${table} (email, name, password_hash) values (:1, :2, :3)`,
					users.map((u) => [u.email, u.name, u.passwordHash]));
			} else {
				await conn.executeMany(`insert into ${table} (id, email, name, password_hash) values (:1, :2, :3, :4)`,
					users.map((u, i) => [toDb(spec, ids[i]), u.email, u.name, u.passwordHash]));
			}
		},

		// Segments: the table heap, plus every index on it (PK, unique email, created_at).
		async size(table) {
			const T = table.toUpperCase();
			const r = await conn.execute(
				`select segment_type, sum(bytes) from user_segments
				 where segment_name = :t or segment_name in (select index_name from user_indexes where table_name = :t)
				 group by segment_type`, { t: T });
			const by = Object.fromEntries(r.rows.map(([t, b]) => [t, Number(b)]));
			return { tableBytes: by.TABLE ?? 0, indexBytes: by.INDEX ?? 0 };
		},

		async byId(table, spec, id) {
			return (await conn.execute(byIdSql(table), [toDb(spec, id)])).rows.length;
		},
		async byEmail(table, email) {
			return (await conn.execute(byEmailSql(table), [email])).rows.length;
		},

		async statsReset(table, col) {
			before = await snapshot(sqlFor(table, col));
		},
		async stats(table, col) {
			const after = await snapshot(sqlFor(table, col));
			const calls = after.e - before.e;
			if (calls <= 0) return null;
			return { serverUs: (after.t - before.t) / calls, readsPerCall: (after.d - before.d) / calls, hitsPerCall: (after.b - before.b) / calls };
		},

		drop: (table) => conn.execute(`begin execute immediate 'drop table ${table} purge'; exception when others then null; end;`),
		async close() {
			await conn.close();
			await admin.close();
		},
	};
}

export default { name: 'oracle', service: 'oracle', supports: () => true, open };
