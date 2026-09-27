import pg from 'pg';

const COLUMN = { db: 'bigint generated always as identity', int: 'bigint', uuid: 'uuid' };
const column = (spec) => COLUMN[spec.kind] ?? `varchar(${spec.len})`;
const COLS = ['account', 'password_hash', 'name', 'phone_number', 'email'];
const rowOf = (u) => [u.account, u.passwordHash, u.name, u.phone, u.email];

async function open() {
	const client = new pg.Client({ host: 'postgres', user: 'postgres', password: 'bench', database: 'bench' });
	await client.connect();
	const q = (text, values) => client.query(text, values);

	return {
		async init() {
			await q('create extension if not exists pg_stat_statements');
			const { rows } = await q('show shared_buffers');
			return { version: (await q('select version()')).rows[0].version, cache: rows[0].shared_buffers };
		},

		async setup(table, spec) {
			await q(`drop table if exists ${table}`);
			await q(`
				create table ${table} (
					id ${column(spec)} primary key,
					account varchar(50) not null unique,
					password_hash varchar(255) not null,
					name varchar(50) not null,
					phone_number varchar(20) not null,
					email varchar(255) not null unique,
					created_at timestamptz not null default now(),
					updated_at timestamptz not null default now()
				)`);
		},

		// Bulk load: one multi-row insert.
		async insert(table, spec, ids, users) {
			const withId = spec.kind !== 'db';
			const cols = withId ? ['id', ...COLS] : COLS;
			const values = [];
			const params = [];
			users.forEach((u, i) => {
				const row = withId ? [ids[i], ...rowOf(u)] : rowOf(u);
				values.push(`(${row.map((_, j) => `$${params.length + j + 1}`).join(',')})`);
				params.push(...row);
			});
			await q(`insert into ${table} (${cols.join(', ')}) values ${values.join(',')}`, params);
		},

		// One row, prepared, autocommit: what an app does on sign-up.
		async insertOne(table, spec, id, u) {
			const withId = spec.kind !== 'db';
			const cols = withId ? ['id', ...COLS] : COLS;
			await client.query({
				name: `ins_${table}`,
				text: `insert into ${table} (${cols.join(', ')}) values (${cols.map((_, j) => `$${j + 1}`).join(',')})`,
				values: withId ? [id, ...rowOf(u)] : rowOf(u),
			});
		},

		async size(table) {
			const { rows } = await q('select pg_table_size($1) as t, pg_indexes_size($1) as i', [table]);
			return { tableBytes: Number(rows[0].t), indexBytes: Number(rows[0].i) };
		},

		async byId(table, spec, id) {
			return (await client.query({ name: `id_${table}`, text: `select * from ${table} where id = $1`, values: [id] })).rows.length;
		},

		// pg_stat_statements: mean execution time inside the server, and blocks that
		// were not in shared_buffers (read from the OS page cache or disk). Execution time
		// leaves out the commit (WAL flush), so for inserts it is the index/heap work alone.
		statsReset: () => q('select pg_stat_statements_reset()'),
		async stats(table, what) {
			const pattern = what === 'insert' ? `insert into ${table} (%` : `select * from ${table} where id = %`;
			const { rows } = await q(
				`select sum(calls) as calls, sum(total_exec_time) as ms, sum(shared_blks_read) as rd, sum(shared_blks_hit) as hit
				 from pg_stat_statements where query like $1`, [pattern]);
			const r = rows[0];
			if (!Number(r.calls)) return null;
			return { serverUs: (Number(r.ms) * 1000) / r.calls, readsPerCall: r.rd / r.calls, hitsPerCall: r.hit / r.calls };
		},

		drop: (table) => q(`drop table if exists ${table}`),
		close: () => client.end(),
	};
}

export default { name: 'postgres', service: 'postgres', open };
