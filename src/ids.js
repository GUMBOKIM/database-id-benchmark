// ID generators. Everything except auto-increment is generated ahead of time
// (src/gen.js) and cached, so insert timings measure only the database, and every
// database sees exactly the same IDs.
//
// gen(i, ms) gets the sign-up time of row i from a simulated clock (gen.js), so
// time-based IDs (timed: true) carry realistic timestamps instead of the few seconds
// it takes to generate millions of them. Others ignore ms.
import { v1, v3, v4, v5, v6, v7, parse as uuidParse } from 'uuid';
import { monotonicFactory } from 'ulid';
import cuid from 'cuid';
import { createId as cuid2 } from '@paralleldrive/cuid2';
import { nanoid } from 'nanoid';
import { ObjectId } from 'bson';
import KSUID from 'ksuid';
import xid from 'xid-js';
import { TypeID } from 'typeid-js';

// Row i of every table is the same user; UUID v3/v5 are derived from this email.
// email and account start with a hash of i, so their unique indexes fill in random
// order like real sign-ups do, whatever the ID type.
export const emailOf = (i) => `${((i * 2654435761) >>> 0).toString(36)}.${i}@example.com`;
export const accountOf = (i) => `${((i * 2246822519) >>> 0).toString(36)}${i.toString(36)}`;
// 48271 is coprime with 10, so this is a permutation of 0..1e8-1: unique numbers.
export const phoneOf = (i) => { const d = String((i * 48271) % 1e8).padStart(8, '0'); return `010-${d.slice(0, 4)}-${d.slice(4)}`; };

// The ulid package is only ordered across milliseconds; the monotonic factory also
// orders IDs made within one millisecond, which is what an app should use.
const ulid = monotonicFactory();

// Twitter-style Snowflake: 41 bits ms since epoch | 10 bits worker | 12 bits sequence.
// ms comes from the simulated clock; the sequence orders IDs within one millisecond.
const EPOCH = 1288834974657n;
let lastMs = -1n;
let seq = 0n;
function snowflake(ms, worker = 1n) {
	let now = BigInt(ms);
	if (now <= lastMs) {
		now = lastMs;
		seq = (seq + 1n) & 0xfffn;
		if (seq === 0n) now += 1n;
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
// timed: takes its timestamp from the simulated clock.
export const ID_TYPES = {
	autoinc: { kind: 'db', sorted: true, label: 'auto increment' },
	snowflake: { kind: 'int', sorted: true, timed: true, gen: (i, ms) => snowflake(ms), label: 'Snowflake' },
	uuidv1: { kind: 'uuid', sorted: false, timed: true, gen: (i, ms) => v1({ msecs: ms }), label: 'UUID v1' },
	uuidv3: { kind: 'uuid', sorted: false, gen: (i) => v3(emailOf(i), v3.URL), label: 'UUID v3' },
	uuidv4: { kind: 'uuid', sorted: false, gen: () => v4(), label: 'UUID v4' },
	uuidv5: { kind: 'uuid', sorted: false, gen: (i) => v5(emailOf(i), v5.URL), label: 'UUID v5' },
	uuidv6: { kind: 'uuid', sorted: true, timed: true, gen: (i, ms) => v6({ msecs: ms }), label: 'UUID v6' },
	uuidv7: { kind: 'uuid', sorted: true, timed: true, gen: (i, ms) => v7({ msecs: ms }), label: 'UUID v7' },
	uuidv4_str: { kind: 'str', len: 36, sorted: false, gen: () => v4(), label: 'UUID v4 (varchar)' },
	ulid: { kind: 'str', len: 26, sorted: true, timed: true, gen: (i, ms) => ulid(ms), label: 'ULID' },
	cuid: { kind: 'str', len: 25, sorted: true, gen: () => cuid(), label: 'CUID v1' },
	cuid2: { kind: 'str', len: 24, sorted: false, gen: () => cuid2(), label: 'CUID2' },
	nanoid: { kind: 'str', len: 21, sorted: false, gen: () => nanoid(), label: 'NanoID' },
	objectid: { kind: 'str', len: 24, sorted: true, gen: () => new ObjectId().toHexString(), label: 'ObjectId' },
	ksuid: { kind: 'str', len: 27, sorted: true, gen: () => KSUID.randomSync().string, label: 'KSUID' },
	xid: { kind: 'str', len: 20, sorted: true, gen: () => xid.next(), label: 'XID' },
	typeid: { kind: 'str', len: 31, sorted: true, timed: true, gen: (i, ms) => TypeID.fromUUID('user', v7({ msecs: ms })).toString(), label: 'TypeID' },
};

export const uuidBytes = (s) => Buffer.from(uuidParse(s));
