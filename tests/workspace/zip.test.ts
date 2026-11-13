import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { crc32, ZipWriter } from '../../src/lib/workspace/zip';

const hasUnzip = spawnSync('unzip', ['-v']).status === 0;
const hasPython = spawnSync('python3', ['-V']).status === 0;

async function zipBytes(files: [string, Uint8Array][], asBlob = false): Promise<Buffer> {
	const z = new ZipWriter(new Date(2026, 10, 13, 14, 30, 22));
	for (const [name, data] of files) z.add(name, asBlob ? { blob: new Blob([data as BlobPart]), crc: crc32(data) } : data);
	return Buffer.from(await z.finish().arrayBuffer());
}

function sample(): [string, Uint8Array][] {
	const big = new Uint8Array(300_000);
	for (let i = 0; i < big.length; i++) big[i] = (i * 7919) & 0xff;
	return [
		['report-001.jpg', new TextEncoder().encode('first file')],
		['report-002.jpg', big],
		['empty.txt', new Uint8Array(0)],
		['naïve résumé.pdf', new TextEncoder().encode('%PDF-1.7 unicode name')]
	];
}

describe('crc32', () => {
	it('matches the standard check value and zlib', () => {
		expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
		expect(crc32(new Uint8Array(0))).toBe(0);
		const data = new Uint8Array(10_000).map((_, i) => (i * 31) & 0xff);
		expect(crc32(data)).toBe(zlib.crc32(data));
	});

	it('continues over chunks', () => {
		const data = new TextEncoder().encode('hello, zip world');
		expect(crc32(data.subarray(5), crc32(data.subarray(0, 5)))).toBe(crc32(data));
	});
});

describe('ZipWriter', () => {
	it('writes the expected structure', async () => {
		const buf = await zipBytes([['a.txt', new TextEncoder().encode('abc')]]);
		expect(buf.readUInt32LE(0)).toBe(0x04034b50);
		expect(buf.readUInt16LE(8)).toBe(0); // stored
		expect(buf.readUInt32LE(14)).toBe(crc32(new TextEncoder().encode('abc')));
		expect(buf.readUInt32LE(18)).toBe(3);
		const end = buf.length - 22;
		expect(buf.readUInt32LE(end)).toBe(0x06054b50);
		expect(buf.readUInt16LE(end + 10)).toBe(1);
		expect(buf.readUInt32LE(end + 16)).toBe(30 + 5 + 3); // directory offset
	});

	it('refuses duplicate and unsafe names', () => {
		const z = new ZipWriter();
		z.add('x.pdf', new Uint8Array(1));
		expect(() => z.add('x.pdf', new Uint8Array(1))).toThrow(/Two files/);
		expect(() => z.add('../x.pdf', new Uint8Array(1))).toThrow(/Bad file name/);
		expect(() => z.add('/abs.pdf', new Uint8Array(1))).toThrow(/Bad file name/);
		expect(() => z.add('', new Uint8Array(1))).toThrow(/Bad file name/);
		expect(z.count).toBe(1);
	});

	it.runIf(hasUnzip)('is read by the system unzip, byte for byte (bytes and Blobs)', async () => {
		for (const asBlob of [false, true]) {
			const dir = mkdtempSync(path.join(tmpdir(), 'zip-test-'));
			const file = path.join(dir, 'out.zip');
			writeFileSync(file, await zipBytes(sample(), asBlob));
			const test = execFileSync('unzip', ['-t', file], { encoding: 'utf8' });
			expect(test).toMatch(/No errors detected/);
			execFileSync('unzip', ['-q', file, '-d', path.join(dir, 'x')]);
			const names = readdirSync(path.join(dir, 'x')).sort();
			expect(names).toEqual(sample().map(([n]) => n).sort());
			for (const [name, data] of sample()) expect(new Uint8Array(readFileSync(path.join(dir, 'x', name)))).toEqual(data);
		}
	});

	it.runIf(hasPython)('is read by Python zipfile (CRC checked, UTF-8 names, timestamps)', async () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'zip-py-'));
		const file = path.join(dir, 'out.zip');
		writeFileSync(file, await zipBytes(sample()));
		const script = [
			'import sys, zipfile, json',
			'z = zipfile.ZipFile(sys.argv[1])',
			'assert z.testzip() is None',
			'print(json.dumps([[i.filename, i.file_size, list(i.date_time), len(z.read(i))] for i in z.infolist()]))'
		].join('\n');
		const out = JSON.parse(execFileSync('python3', ['-I', '-c', script, file], { encoding: 'utf8' })) as [string, number, number[], number][];
		expect(out.map((e) => e[0])).toEqual(sample().map(([n]) => n));
		expect(out.map((e) => e[1])).toEqual(sample().map(([, d]) => d.length));
		expect(out[0][2]).toEqual([2026, 11, 13, 14, 30, 22]);
	});
});
