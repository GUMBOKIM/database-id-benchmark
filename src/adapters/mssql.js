// SQL Server 2022. The primary key is a clustered index by default, like InnoDB.
// Note: SQL Server sorts UNIQUEIDENTIFIER by its last 6 bytes first, so a UUID v7
// stored there is NOT in insertion order. That is part of what this measures.
import sql from 'mssql';
import { CACHE_MB } from '../config.js';

const base = { server: 'mssql', user: 'sa', password: 'Bench_12345', options: { encrypt: false, trustServerCertificate: true } };
// SQL Server limits a statement to 2100 parameters, so a 1000-row batch is sent in chunks.
const CHUNK = 500;

const column = (spec) => {
	switch (spec.kind) {
		case 'db': return 'bigint identity(1,1)';
		case 'int': return 'bigint';
		case 'uuid': return 'uniqueidentifier';
		default: return `varchar(${spec.len})`;
	}
};
const idType = (spec) => (spec.kind === 'uuid' ? sql.UniqueIdentifier : spec.kind === 'int' ? sql.BigInt : sql.VarChar(spec.len ?? 36));

let prepared = false;
async function prepare() {
	if (prepared) return;
	const pool = await new sql.ConnectionPool({ ...base, database: 'master', pool: { max: 1 } }).connect();
	await pool.query(`if db_id('bench') is null create database bench`);
	await pool.query(`alter database bench set recovery simple`);
	// There is no buffer-pool-only knob; max server memory is the closest equivalent.
	await pool.query(`exec sp_configure 'show advanced options', 1; reconfigure;
		exec sp_configure 'max server memory (MB)', ${CACHE_MB}; reconfigure;`);
	await pool.close();
	prepared = true;
}

async function open() {
	await prepare();
	const pool = await new sql.ConnectionPool({ ...base, database: 'bench', pool: { max: 1 } }).connect();
	const q = (text) => pool.request().query(text);
	let before = {};

	async function snapshot(table, col) {
		const r = await q(`
			select isnull(sum(qs.execution_count),0) as e, isnull(sum(qs.total_elapsed_time),0) as t,
			       isnull(sum(qs.total_physical_reads),0) as d, isnull(sum(qs.total_logical_reads),0) as b
			from sys.dm_exec_query_stats qs cross apply sys.dm_exec_sql_text(qs.sql_handle) st
			where st.text like '%select * from ${table} where ${col} = @p0%'`);
		const row = r.recordset[0];
		return { e: Number(row.e), t: Number(row.t), d: Number(row.d), b: Number(row.b) };
	}

	return {
		async init() {
			const r = await q(`select @@version as v, (select value_in_use from sys.configurations where name = 'max server memory (MB)') as m`);
			return { version: r.recordset[0].v, cache: `${r.recordset[0].m}MB (max server memory)`, cacheMb: CACHE_MB };
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
					created_at datetime2 not null default sysutcdatetime(),
					updated_at datetime2 not null default sysutcdatetime()
				)`);
			await q(`create index ix_${table}_created_at on ${table} (created_at)`);
		},

		async insert(table, spec, ids, users) {
			const withId = spec.kind !== 'db';
			for (let off = 0; off < users.length; off += CHUNK) {
				const req = pool.request();
				const values = [];
				users.slice(off, off + CHUNK).forEach((u, j) => {
					const i = off + j;
					const names = [];
					if (withId) { req.input(`i${j}`, idType(spec), ids[i]); names.push(`@i${j}`); }
					req.input(`e${j}`, sql.VarChar(255), u.email);
					req.input(`n${j}`, sql.VarChar(100), u.name);
					req.input(`h${j}`, sql.VarChar(255), u.passwordHash);
					names.push(`@e${j}`, `@n${j}`, `@h${j}`);
					values.push(`(${names.join(',')})`);
				});
				const cols = withId ? 'id, email, name, password_hash' : 'email, name, password_hash';
				await req.query(`insert into ${table} (${cols}) values ${values.join(',')}`);
			}
		},

		// index_id 1 is the clustered index (= the table); > 1 are secondary indexes.
		async size(table) {
			const r = await q(`
				select sum(case when index_id <= 1 then used_page_count else 0 end) * 8192 as t,
				       sum(case when index_id > 1 then used_page_count else 0 end) * 8192 as i
				from sys.dm_db_partition_stats where object_id = object_id('${table}')`);
			return { tableBytes: Number(r.recordset[0].t), indexBytes: Number(r.recordset[0].i) };
		},

		async byId(table, spec, id) {
			return (await pool.request().input('p0', idType(spec), id).query(`select * from ${table} where id = @p0`)).recordset.length;
		},
		async byEmail(table, email) {
			return (await pool.request().input('p0', sql.VarChar(255), email).query(`select * from ${table} where email = @p0`)).recordset.length;
		},

		async statsReset(table, col) {
			before = await snapshot(table, col);
		},
		async stats(table, col) {
			const after = await snapshot(table, col);
			const calls = after.e - before.e;
			if (calls <= 0) return null;
			return { serverUs: (after.t - before.t) / calls, readsPerCall: (after.d - before.d) / calls, hitsPerCall: (after.b - before.b) / calls };
		},

		drop: (table) => q(`drop table if exists ${table}`),
		close: () => pool.close(),
	};
}

export default { name: 'mssql', service: 'mssql', supports: () => true, open };
