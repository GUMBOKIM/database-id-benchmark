// Shared by MySQL and MariaDB. The only schema difference is the UUID column:
// MySQL has no uuid type, so it goes into BINARY(16); MariaDB has a native UUID type.
import mysql from 'mysql2/promise';
import { uuidBytes } from '../ids.js';

function make({ name, nativeUuid }) {
	const column = (spec) => {
		switch (spec.kind) {
			case 'db': return 'bigint not null auto_increment';
			case 'int': return 'bigint not null';
			case 'uuid': return nativeUuid ? 'uuid not null' : 'binary(16) not null';
			default: return `varchar(${spec.len}) not null`;
		}
	};
	const toDb = (spec, id) => (spec.kind === 'uuid' && !nativeUuid ? uuidBytes(id) : id);
	const COLS = 'account, password_hash, name, phone_number, email';
	const rowOf = (u) => [u.account, u.passwordHash, u.name, u.phone, u.email];

	async function open() {
		const conn = await mysql.createConnection({ host: name, user: 'root', password: 'bench', database: 'bench' });
		const q = async (sql, params) => (await conn.query(sql, params))[0];
		const diskReads = async () => Number((await q(`show global status like 'Innodb_buffer_pool_reads'`))[0].Value);
		let before = {};
		const prepared = async (table, what) => {
			const [r] = await q(
				`select coalesce(sum(count_execute), 0) as calls, coalesce(sum(sum_timer_execute), 0) as ps
				 from performance_schema.prepared_statements_instances where sql_text like ?`,
				[what === 'insert' ? `insert into ${table} (%` : `select * from ${table} where id = ?`]);
			return { calls: Number(r.calls), ps: Number(r.ps) };
		};

		return {
			async init() {
				const [v] = await q('select version() as v, @@innodb_buffer_pool_size as bp');
				return { version: v.v, cache: `${Number(v.bp) / 2 ** 20}MB` };
			},

			async setup(table, spec) {
				await q(`drop table if exists ${table}`);
				await q(`
					create table ${table} (
						id ${column(spec)} primary key,
						account varchar(50) not null,
						password_hash varchar(255) not null,
						name varchar(50) not null,
						phone_number varchar(20) not null,
						email varchar(255) not null,
						created_at datetime(6) not null default current_timestamp(6),
						updated_at datetime(6) not null default current_timestamp(6),
						unique key uq_account (account),
						unique key uq_email (email)
					) engine=InnoDB`);
			},

			// Bulk load: one multi-row insert.
			async insert(table, spec, ids, users) {
				if (spec.kind === 'db') {
					await q(`insert into ${table} (${COLS}) values ?`, [users.map(rowOf)]);
				} else {
					await q(`insert into ${table} (id, ${COLS}) values ?`, [users.map((u, i) => [toDb(spec, ids[i]), ...rowOf(u)])]);
				}
			},

			// One row, prepared, autocommit: what an app does on sign-up.
			async insertOne(table, spec, id, u) {
				if (spec.kind === 'db') {
					await conn.execute(`insert into ${table} (${COLS}) values (?, ?, ?, ?, ?)`, rowOf(u));
				} else {
					await conn.execute(`insert into ${table} (id, ${COLS}) values (?, ?, ?, ?, ?, ?)`, [toDb(spec, id), ...rowOf(u)]);
				}
			},

			// InnoDB keeps rows inside the primary-key index (clustered), so data_length is
			// "table + PK"; index_length is the secondary indexes, each of which stores the PK too.
			async size(table) {
				await q(`analyze table ${table}`);
				const [r] = await q(
					`select data_length as d, index_length as i from information_schema.tables where table_schema = 'bench' and table_name = ?`, [table]);
				return { tableBytes: Number(r.d), indexBytes: Number(r.i) };
			},

			async byId(table, spec, id) {
				return (await conn.execute(`select * from ${table} where id = ?`, [toDb(spec, id)]))[0].length;
			},

			// Server-side time of our prepared statements (performance_schema, cumulative, so
			// stats() diffs two snapshots). Innodb_buffer_pool_reads counts pages that were not
			// in the buffer pool and had to be read from disk (a global counter).
			async statsReset(table, what) {
				before = { ...(await prepared(table, what)), reads: await diskReads() };
			},
			async stats(table, what) {
				const after = await prepared(table, what);
				const calls = after.calls - before.calls;
				if (calls <= 0) return null;
				return { serverUs: (after.ps - before.ps) / 1e6 / calls, readsPerCall: ((await diskReads()) - before.reads) / calls };
			},

			drop: (table) => q(`drop table if exists ${table}`),
			close: () => conn.end(),
		};
	}

	return { name, service: name, open };
}

export const mysqlAdapter = make({ name: 'mysql', nativeUuid: false });
export const mariadbAdapter = make({ name: 'mariadb', nativeUuid: true });
