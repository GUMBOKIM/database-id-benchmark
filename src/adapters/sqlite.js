// SQLite through Node's built-in node:sqlite, running inside the runner container.
// Two variants:
//   sqlite         - ordinary rowid table. A non-integer PK becomes a separate unique
//                    index next to the rowid-ordered table.
//   sqlite_norowid - WITHOUT ROWID: the table is stored in PK order (clustered),
//                    like InnoDB. Has no auto-increment, so autoinc is skipped.
// Each table gets its own database file so its size can be read from the file.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { CACHE_MB } from '../config.js';
import { uuidBytes } from '../ids.js';

const DIR = '/data';

function make({ name, withoutRowid }) {
	// integer primary key is an alias of the rowid, so autoinc and Snowflake both use it.
	const column = (spec) => ({ db: 'integer', int: 'integer', uuid: 'blob' })[spec.kind] ?? 'text';
	const toDb = (spec, id) => (spec.kind === 'uuid' ? uuidBytes(id) : spec.kind === 'int' ? BigInt(id) : id);

	async function open() {
		mkdirSync(DIR, { recursive: true });
		const dbs = new Map();
		const get = (table) => dbs.get(table);
		const file = (table) => `${DIR}/${name}_${table}.db`;
		// Prepared statements for the current table; cleared whenever a new table is set up.
		const stmts = new Map();
		const stmt = (db, text) => {
			if (!stmts.has(text)) {
				const st = db.prepare(text);
				st.setReadBigInts(true); // Snowflake IDs do not fit in a JS number
				stmts.set(text, st);
			}
			return stmts.get(text);
		};

		return {
			async init() {
				const db = new DatabaseSync(':memory:');
				const v = db.prepare('select sqlite_version() as v').get().v;
				db.close();
				return { version: `SQLite ${v}${withoutRowid ? ' (WITHOUT ROWID)' : ''}`, cache: `${CACHE_MB}MB`, cacheMb: CACHE_MB };
			},

			async setup(table, spec) {
				rmSync(file(table), { force: true });
				rmSync(`${file(table)}-wal`, { force: true });
				const db = new DatabaseSync(file(table));
				db.exec(`pragma journal_mode = wal; pragma synchronous = normal; pragma cache_size = -${CACHE_MB * 1024};`);
				db.exec(`
					create table ${table} (
						id ${column(spec)} primary key,
						email text not null unique,
						name text not null,
						password_hash text not null,
						status text not null default 'active',
						created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ')),
						updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ'))
					)${withoutRowid ? ' without rowid' : ''};
					create index ${table}_created_at on ${table} (created_at);`);
				dbs.set(table, db);
				stmts.clear();
			},

			async insert(table, spec, ids, users) {
				const db = get(table);
				const withId = spec.kind !== 'db';
				const ins = withId
					? stmt(db, `insert into ${table} (id, email, name, password_hash) values (?, ?, ?, ?)`)
					: stmt(db, `insert into ${table} (email, name, password_hash) values (?, ?, ?)`);
				// One transaction per batch, the same unit of work as one multi-row INSERT elsewhere.
				db.exec('begin');
				users.forEach((u, i) => (withId ? ins.run(toDb(spec, ids[i]), u.email, u.name, u.passwordHash) : ins.run(u.email, u.name, u.passwordHash)));
				db.exec('commit');
			},

			async size(table) {
				const db = get(table);
				db.exec('pragma wal_checkpoint(truncate); analyze;');
				// dbstat splits pages per table/index when SQLite is built with it.
				try {
					const rows = db.prepare(`select name, sum(pgsize) as bytes from dbstat group by name`).all();
					const tableBytes = rows.filter((r) => r.name === table).reduce((s, r) => s + Number(r.bytes), 0);
					const indexBytes = rows.filter((r) => r.name !== table && !r.name.startsWith('sqlite_stat') && r.name !== 'sqlite_schema').reduce((s, r) => s + Number(r.bytes), 0);
					return { tableBytes, indexBytes };
				} catch {
					return { tableBytes: statSync(file(table)).size, indexBytes: 0 };
				}
			},

			async byId(table, spec, id) {
				return stmt(get(table), `select * from ${table} where id = ?`).get(toDb(spec, id)) ? 1 : 0;
			},
			async byEmail(table, email) {
				return stmt(get(table), `select * from ${table} where email = ?`).get(email) ? 1 : 0;
			},

			// In-process: client-side time already is the engine time.
			async statsReset() {},
			async stats() {
				return null;
			},

			async drop(table) {
				get(table)?.close();
				dbs.delete(table);
				rmSync(file(table), { force: true });
				rmSync(`${file(table)}-wal`, { force: true });
				rmSync(`${file(table)}-shm`, { force: true });
			},
			async close() {
				for (const db of dbs.values()) db.close();
			},
		};
	}

	return {
		name,
		service: null,
		supports: (spec) => !(withoutRowid && spec.kind === 'db'),
		concurrent: false, // one writer at a time; the concurrent-insert test is skipped
		open,
	};
}

export const sqliteAdapter = make({ name: 'sqlite', withoutRowid: false });
export const sqliteNoRowidAdapter = make({ name: 'sqlite_norowid', withoutRowid: true });
