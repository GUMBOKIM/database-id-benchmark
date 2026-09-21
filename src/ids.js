// ID generators. Everything except auto-increment is generated ahead of time
// (src/gen.js) and cached, so insert timings measure only the database, and every
// database sees exactly the same IDs.
import { v1, v3, v4, v5, v6, v7, parse as uuidParse } from 'uuid';
import { ulid } from 'ulid';
import cuid from 'cuid';
import { createId as cuid2 } from '@paralleldrive/cuid2';
import { nanoid } from 'nanoid';
import { ObjectId } from 'bson';
import KSUID from 'ksuid';
import xid from 'xid-js';
import { typeid } from 'typeid-js';

// Row i of every table is the same user; UUID v3/v5 are derived from this email.
export const emailOf = (i) => `${((i * 2654435761) >>> 0).toString(36)}.${i}@example.com`;

// Twitter-style Snowflake: 41 bits ms since epoch | 10 bits worker | 12 bits sequence.
const EPOCH = 1288834974657n;
let lastMs = -1n;
let seq = 0n;
function snowflake(worker = 1n) {
	let now = BigInt(Date.now());
	if (now === lastMs) {
		seq = (seq + 1n) & 0xfffn;
		if (seq === 0n) while (now <= lastMs) now = BigInt(Date.now());
	} else {
		seq = 0n;
	}
	lastMs = now;
	return (((now - EPOCH) << 22n) | (worker << 12n) | seq).toString();
}

// kind decides the column type:
//   db   - the database generates it (identity / auto_increment / rowid)
//   int  - 64-bit integer
//   uuid - native uuid type, or 16-byte binary where there is none
//   str  - varchar(len), the way these IDs are usually stored
// sorted: whether new IDs are (roughly) increasing, for the write-up.
export const ID_TYPES = {
	autoinc: { kind: 'db', sorted: true, label: 'auto increment' },
	snowflake: { kind: 'int', sorted: true, gen: () => snowflake(), label: 'Snowflake' },
	uuidv1: { kind: 'uuid', sorted: false, gen: () => v1(), label: 'UUID v1' },
	uuidv3: { kind: 'uuid', sorted: false, gen: (i) => v3(emailOf(i), v3.URL), label: 'UUID v3' },
	uuidv4: { kind: 'uuid', sorted: false, gen: () => v4(), label: 'UUID v4' },
	uuidv5: { kind: 'uuid', sorted: false, gen: (i) => v5(emailOf(i), v5.URL), label: 'UUID v5' },
	uuidv6: { kind: 'uuid', sorted: true, gen: () => v6(), label: 'UUID v6' },
	uuidv7: { kind: 'uuid', sorted: true, gen: () => v7(), label: 'UUID v7' },
	uuidv4_str: { kind: 'str', len: 36, sorted: false, gen: () => v4(), label: 'UUID v4 (varchar)' },
	ulid: { kind: 'str', len: 26, sorted: true, gen: () => ulid(), label: 'ULID' },
	cuid: { kind: 'str', len: 25, sorted: true, gen: () => cuid(), label: 'CUID v1' },
	cuid2: { kind: 'str', len: 24, sorted: false, gen: () => cuid2(), label: 'CUID2' },
	nanoid: { kind: 'str', len: 21, sorted: false, gen: () => nanoid(), label: 'NanoID' },
	objectid: { kind: 'str', len: 24, sorted: true, gen: () => new ObjectId().toHexString(), label: 'ObjectId' },
	ksuid: { kind: 'str', len: 27, sorted: true, gen: () => KSUID.randomSync().string, label: 'KSUID' },
	xid: { kind: 'str', len: 20, sorted: true, gen: () => xid.next(), label: 'XID' },
	typeid: { kind: 'str', len: 31, sorted: true, gen: () => typeid('user').toString(), label: 'TypeID' },
};

export const uuidBytes = (s) => Buffer.from(uuidParse(s));
