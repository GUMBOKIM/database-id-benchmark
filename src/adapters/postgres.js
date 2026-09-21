import pg from 'pg';
import { CACHE_MB } from '../config.js';

const COLUMN = { db: 'bigint generated always as identity', int: 'bigint', uuid: 'uuid' };
const column = (spec) => COLUMN[spec.kind] ?? `varchar(${spec.len})`;

async function open() {
	const client = new pg.Client({ host: 'postgres', user: 'postgres', password: 'bench', database: 'bench' });
	await client.connect();
	const q = (text, values) => client.query(text, values);

	return {
		async init() {
			await q('create extension if not exists pg_stat_statements');
			const { rows } = await q('show shared_buffers');
			return { version: (await q('select version()')).rows[0].version, cache: rows[0].shared_buffers, cacheMb: CACHE_MB };
		},

		async setup(table, spec) {
			await q(`drop table if exists ${table}`);
			await q(`
				create table ${table} (
					id ${column(spec)} primary key,
					email varchar(255) not null unique,
					name varchar(100) not null,
					password_hash varchar(255) not null,
					status varchar(20) not null default 'active',
					created_at timestamptz not null default now(),
					updated_at timestamptz not null default now()
				)`);
			await q(`create index ${table}_created_at on ${table} (created_at)`);
		},

		async insert(table, spec, ids, users) {
			const withId = spec.kind !== 'db';
			const cols = withId ? 'id, email, name, password_hash' : 'email, name, password_hash';
			const values = [];
			const params = [];
			users.forEach((u, i) => {
				const row = withId ? [ids[i], u.email, u.name, u.passwordHash] : [u.email, u.name, u.passwordHash];
				values.push(`(${row.map((_, j) => `$${params.length + j + 1}`).join(',')})`);
				params.push(...row);
			});
			await q(`insert into ${table} (${cols}) values ${values.join(',')}`, params);
		},

		async size(table) {
			await q(`vacuum analyze ${table}`);
			const { rows } = await q('select pg_table_size($1) as t, pg_indexes_size($1) as i', [table]);
			return { tableBytes: Number(rows[0].t), indexBytes: Number(rows[0].i) };
		},

		async byId(table, spec, id) {
			return (await client.query({ name: `id_${table}`, text: `select * from ${table} where id = $1`, values: [id] })).rows.length;
		},
		async byEmail(table, email) {
			return (await client.query({ name: `em_${table}`, text: `select * from ${table} where email = $1`, values: [email] })).rows.length;
		},

		// pg_stat_statements: mean execution time inside the server, and blocks that
		// were not in shared_buffers (read from the OS page cache or disk).
		statsReset: () => q('select pg_stat_statements_reset()'),
		async stats(table, col) {
			const { rows } = await q(
				`select sum(calls) as calls, sum(total_exec_time) as ms, sum(shared_blks_read) as rd, sum(shared_blks_hit) as hit
				 from pg_stat_statements where query like $1`, [`select * from ${table} where ${col} = %`]);
			const r = rows[0];
			if (!Number(r.calls)) return null;
			return { serverUs: (Number(r.ms) * 1000) / r.calls, readsPerCall: r.rd / r.calls, hitsPerCall: r.hit / r.calls };
		},

		drop: (table) => q(`drop table if exists ${table}`),
		close: () => client.end(),
	};
}

export default { name: 'postgres', service: 'postgres', supports: () => true, open };
