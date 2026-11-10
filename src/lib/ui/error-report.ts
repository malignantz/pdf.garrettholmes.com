/** Everything useful about a thrown value, whatever it is, for a bug report. */
export function describeError(err: unknown): string {
	const lines: string[] = [];
	if (err instanceof Error) {
		lines.push(`${err.name}: ${err.message}`, err.stack ?? '');
		if (err.cause !== undefined) lines.push(`cause: ${describeError(err.cause)}`);
	} else if (err && typeof err === 'object') {
		const o = err as Record<string, unknown>;
		let json = '';
		try {
			json = JSON.stringify(o);
		} catch {
			json = '(not serializable)';
		}
		lines.push(`${o.constructor?.name ?? 'object'} ${json.slice(0, 300)}`, String(o.stack ?? ''));
	} else lines.push(String(err));
	return lines.filter(Boolean).join('\n');
}
