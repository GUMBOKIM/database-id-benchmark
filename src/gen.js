// Generates every ID type once into cache/<type>.txt (one per line) and records how
// long generation took. Existing cache files that are long enough are reused.
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { ID_TYPES } from './ids.js';
import { TYPES, maxNFor } from './config.js';

mkdirSync('cache', { recursive: true });
const metaFile = 'cache/meta.json';
const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : {};

for (const type of TYPES) {
	const spec = ID_TYPES[type];
	if (spec.kind === 'db') continue;
	const n = maxNFor(type);
	const file = `cache/${type}.txt`;
	if (existsSync(file) && meta[type]?.n >= n && statSync(file).size > 0) {
		console.log(`cached  ${type} (${meta[type].n})`);
		continue;
	}
	const out = createWriteStream(file);
	const t0 = process.hrtime.bigint();
	let buf = [];
	for (let i = 0; i < n; i++) {
		buf.push(spec.gen(i));
		if (buf.length === 100_000) {
			if (!out.write(buf.join('\n') + '\n')) await new Promise((r) => out.once('drain', r));
			buf = [];
		}
	}
	if (buf.length) out.write(buf.join('\n') + '\n');
	await new Promise((r) => out.end(r));
	// Includes the (small) cost of writing the file; good enough to compare generators.
	const nsPerId = Number(process.hrtime.bigint() - t0) / n;
	meta[type] = { n, nsPerId };
	writeFileSync(metaFile, JSON.stringify(meta, null, 2));
	console.log(`generated ${type}: ${n} ids, ${nsPerId.toFixed(0)} ns/id`);
}
