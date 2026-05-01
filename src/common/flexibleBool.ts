/**
 * Decode a Phabricator boolean field tolerantly.
 *
 * `transaction.search` emits these as real booleans on some instances, as the
 * integers 0/1, or as the strings "0"/"1". JS treats "0" as truthy, so a naive
 * `?:` mis-routes comments. When the field is missing entirely, fall back to
 * the supplied default.
 */
export function flexibleBool(value: unknown, fallback: boolean): boolean {
	if (typeof value === 'boolean') {
		return value;
	}
	if (typeof value === 'number') {
		return value !== 0;
	}
	if (typeof value === 'string') {
		const lowered = value.toLowerCase();
		if (lowered === '1' || lowered === 'true') return true;
		if (lowered === '0' || lowered === 'false') return false;
	}
	return fallback;
}
