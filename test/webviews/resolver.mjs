const TS_EXTS = ['.ts', '.tsx'];

export async function resolve(specifier, context, nextResolve) {
	if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
		for (const ext of TS_EXTS) {
			try {
				return await nextResolve(specifier + ext, context);
			} catch {}
		}
	}
	return nextResolve(specifier, context);
}
