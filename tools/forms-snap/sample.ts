/** The sample file of a measurement folder (copied from the blank detector's samples). */
import fs from 'node:fs';
import path from 'node:path';
import type { SampleFile } from '../forms-detect/measure';

export function loadSample(out: string): SampleFile[] {
	return (JSON.parse(fs.readFileSync(path.join(out, 'sample.json'), 'utf8')) as { files: SampleFile[] }).files;
}
