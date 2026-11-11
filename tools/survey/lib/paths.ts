import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const surveyDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = path.resolve(surveyDir, '../..');
