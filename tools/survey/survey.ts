/**
 * Survey harness entry point: `node <flags> tools/survey/survey.ts <step> [options]`.
 * Steps: profile, sample, run, report. See tools/survey/README.md.
 */
import { parseArgs } from './lib/common';

const [step, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

switch (step) {
	case 'profile':
		await (await import('./profile')).profileCommand(args);
		break;
	case 'sample':
		await (await import('./sample')).sampleCommand(args);
		break;
	case 'run':
		await (await import('./run')).runCommand(args);
		break;
	case 'report':
		await (await import('./report')).reportCommand(args);
		break;
	default:
		console.error('usage: survey.ts <profile|sample|run|report> [--out DIR] [options]');
		process.exit(2);
}
