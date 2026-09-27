// Generates every ID type once into cache/<type>.txt (one per line) and records how
// long generation took. Existing cache files that are long enough are reused.
// With several types, each one is generated in its own process, side by side
// (CUID2 alone takes minutes for 10M IDs).
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { ID_TYPES } from './ids.js';
import { TYPES, N_MAX } from './config.js';

mkdirSync('cache', { recursive: true });
if (TYPES.length > 1) {
	const codes = await Promise.all(TYPES.map((type) => new Promise((resolve) => {
		spawn(process.execPath, [process.argv[1]], { env: { ...process.env, TYPES: type }, stdio: 'inherit' }).on('exit', resolve);
	})));
	process.exit(codes.some((c) => c !== 0) ? 1 : 0);
}
const metaFile = 'cache/meta.json';
const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : {};

for (const type of TYPES) {
	const spec = ID_TYPES[type];
	if (spec.kind === 'db') continue;
	const n = N_MAX;
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
	const latest = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : {};
	latest[type] = { n, nsPerId };
	writeFileSync(metaFile, JSON.stringify(latest, null, 2));
	console.log(`generated ${type}: ${n} ids, ${nsPerId.toFixed(0)} ns/id`);
}
