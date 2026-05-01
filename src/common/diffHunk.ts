/*---------------------------------------------------------------------------------------------
 *  Adapted from vscode-pull-request-github (MIT License, Copyright Microsoft Corporation).
 *  Trimmed: drops GitHub-specific parsePatch / parseDiff branches.
 *--------------------------------------------------------------------------------------------*/

export enum DiffChangeType {
	Context,
	Add,
	Delete,
	Control,
}

export class DiffLine {
	constructor(
		public type: DiffChangeType,
		public oldLineNumber: number,
		public newLineNumber: number,
		public positionInHunk: number,
		public text: string,
		public endwithLineBreak: boolean = true,
	) {}
}

export class DiffHunk {
	public diffLines: DiffLine[] = [];
	constructor(
		public oldLineNumber: number,
		public oldLength: number,
		public newLineNumber: number,
		public newLength: number,
		public positionInHunk: number,
	) {}
}

export const DIFF_HUNK_HEADER = /^@@ -(\d+)(,(\d+))?( \+(\d+)(,(\d+)?)?)? @@/;

export function getDiffChangeType(text: string): DiffChangeType {
	const c = text[0];
	switch (c) {
		case ' ':
			return DiffChangeType.Context;
		case '+':
			return DiffChangeType.Add;
		case '-':
			return DiffChangeType.Delete;
		default:
			return DiffChangeType.Control;
	}
}

export function* lineReader(text: string): IterableIterator<string> {
	let lastLineEnd = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '\n') {
			yield text.substring(lastLineEnd, i + 1);
			lastLineEnd = i + 1;
		}
	}
	if (lastLineEnd < text.length) {
		yield text.substring(lastLineEnd);
	}
}

/**
 * Parse a unified diff hunk fragment (the `@@ -..  +.. @@` header and its lines).
 * Yields DiffHunk values as they're discovered.
 */
export function* parseDiffHunk(diffHunkPatch: string): IterableIterator<DiffHunk> {
	const lines = lineReader(diffHunkPatch);
	let itr = lines.next();
	let diffHunk: DiffHunk | undefined;
	let positionInHunk = -1;
	let oldLine = -1;
	let newLine = -1;

	while (!itr.done) {
		const line = itr.value.replace(/\r?\n$/, '');
		const match = DIFF_HUNK_HEADER.exec(line);
		if (match) {
			if (diffHunk) {
				yield diffHunk;
			}
			positionInHunk = 0;
			const oldStart = Number(match[1]);
			const oldLen = match[3] === undefined ? 1 : Number(match[3]);
			const newStart = Number(match[5]);
			const newLen = match[7] === undefined ? 1 : Number(match[7]);
			diffHunk = new DiffHunk(oldStart, oldLen, newStart, newLen, positionInHunk);
			oldLine = oldStart;
			newLine = newStart;
		} else if (diffHunk !== undefined) {
			const type = getDiffChangeType(line);
			if (type === DiffChangeType.Control) {
				// "\ No newline at end of file" markers
				if (diffHunk.diffLines && diffHunk.diffLines.length) {
					diffHunk.diffLines[diffHunk.diffLines.length - 1].endwithLineBreak = false;
				}
			} else {
				diffHunk.diffLines.push(
					new DiffLine(
						type,
						type !== DiffChangeType.Add ? oldLine : -1,
						type !== DiffChangeType.Delete ? newLine : -1,
						positionInHunk,
						line,
					),
				);
				const oldAdvance = type !== DiffChangeType.Add ? 1 : 0;
				const newAdvance = type !== DiffChangeType.Delete ? 1 : 0;
				oldLine += oldAdvance;
				newLine += newAdvance;
			}
		}
		positionInHunk++;
		itr = lines.next();
	}

	if (diffHunk) {
		yield diffHunk;
	}
}

/**
 * Split a multi-file unified diff into per-file blocks.
 *
 * Recognizes the `diff --git a/x b/y` header form that Phabricator's
 * differential.getrawdiff produces. Returns a map keyed by the file's
 * "after" path (or "before" path for deletes).
 */
export interface ParsedFile {
	oldPath: string | null;
	newPath: string | null;
	status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied';
	patch: string;
	hunks: DiffHunk[];
	binary: boolean;
}

export function parseUnifiedDiff(rawDiff: string): ParsedFile[] {
	const out: ParsedFile[] = [];
	const lines = rawDiff.split('\n');

	let i = 0;
	while (i < lines.length) {
		if (!lines[i].startsWith('diff ')) {
			i++;
			continue;
		}
		const header: string[] = [];
		const start = i;
		header.push(lines[i++]);
		let oldPath: string | null = null;
		let newPath: string | null = null;
		let status: ParsedFile['status'] = 'modified';
		let binary = false;

		while (i < lines.length && !lines[i].startsWith('diff ') && !lines[i].startsWith('@@')) {
			const line = lines[i];
			header.push(line);
			if (line.startsWith('--- a/')) {
				oldPath = line.slice(6);
			} else if (line.startsWith('--- ') && line !== '--- /dev/null') {
				oldPath = line.slice(4);
			} else if (line === '--- /dev/null') {
				status = 'added';
			} else if (line.startsWith('+++ b/')) {
				newPath = line.slice(6);
			} else if (line.startsWith('+++ ') && line !== '+++ /dev/null') {
				newPath = line.slice(4);
			} else if (line === '+++ /dev/null') {
				status = 'removed';
			} else if (line.startsWith('rename from ')) {
				status = 'renamed';
				oldPath = line.slice('rename from '.length);
			} else if (line.startsWith('rename to ')) {
				newPath = line.slice('rename to '.length);
			} else if (line.startsWith('copy from ')) {
				status = 'copied';
				oldPath = line.slice('copy from '.length);
			} else if (line.startsWith('copy to ')) {
				newPath = line.slice('copy to '.length);
			} else if (line.startsWith('Binary files ')) {
				binary = true;
			}
			i++;
		}

		const hunkStart = i;
		while (i < lines.length && !lines[i].startsWith('diff ')) {
			i++;
		}
		const hunkText = lines.slice(hunkStart, i).join('\n');
		const patch = lines.slice(start, i).join('\n');
		const hunks = binary ? [] : Array.from(parseDiffHunk(hunkText));

		// Try to recover paths from the `diff --git a/x b/y` header if individual lines didn't set them.
		if (!newPath || !oldPath) {
			const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(lines[start]);
			if (m) {
				if (!oldPath) oldPath = m[1];
				if (!newPath) newPath = m[2];
			}
		}

		out.push({
			oldPath: status === 'added' ? null : oldPath,
			newPath: status === 'removed' ? null : newPath,
			status,
			patch,
			hunks,
			binary,
		});
	}
	return out;
}

/**
 * Reconstruct the "before" or "after" side of a file purely from its hunks.
 *
 * We don't have access to the base-revision content, so files where the diff
 * does not cover every line will appear truncated to only the touched regions.
 * For ADD and REMOVE this is exact; for MODIFY it produces a context-only view
 * (which the editor still diffs correctly because both sides come from the same
 * representation).
 */
export function reconstructSideFromHunks(hunks: DiffHunk[], side: 'before' | 'after'): string {
	const lines: string[] = [];
	const skipType = side === 'before' ? DiffChangeType.Add : DiffChangeType.Delete;
	for (const hunk of hunks) {
		for (const line of hunk.diffLines) {
			if (line.type === skipType) {
				continue;
			}
			lines.push(line.text.slice(1));
		}
	}
	return lines.join('\n') + (lines.length ? '\n' : '');
}

/**
 * Synthesize a side ('before'/'after') from a Phabricator hunk corpus.
 *
 * Each line of the corpus starts with one of:
 *   ' '  context (in both)
 *   '-'  removed (only in 'before')
 *   '+'  added (only in 'after')
 *   '\\' "no newline at end of file" marker (skip)
 *
 * Mozilla's Phabricator emits hunks with effectively unlimited context for
 * normal files, so the corpus contains the entire file. Concatenate every
 * hunk's corpus in order to get the whole document.
 */
export function synthesizeSideFromCorpus(corpus: string, side: 'before' | 'after'): string {
	const skipPrefix = side === 'before' ? '+' : '-';
	const out: string[] = [];
	const lines = corpus.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// The corpus often ends with a trailing newline → empty last element.
		if (line.length === 0 && i === lines.length - 1) {
			break;
		}
		const prefix = line[0];
		if (prefix === '\\' || prefix === undefined) {
			continue;
		}
		if (prefix === skipPrefix) {
			continue;
		}
		out.push(line.slice(1));
	}
	return out.join('\n') + (out.length ? '\n' : '');
}

/**
 * Reconstruct a side using empty padding for unchanged regions, so the
 * resulting document's line numbers match the real file's line numbers.
 *
 * Used when we can't fetch base content but still want inline comments to
 * anchor on the right line. Lines outside any hunk become empty.
 */
export function paddedReconstruction(hunks: DiffHunk[], side: 'before' | 'after'): string {
	const skipType = side === 'before' ? DiffChangeType.Add : DiffChangeType.Delete;
	const lines: string[] = [];
	const padTo = (target: number) => {
		while (lines.length < target) {
			lines.push('');
		}
	};
	for (const hunk of hunks) {
		const startLine = side === 'before' ? hunk.oldLineNumber : hunk.newLineNumber;
		padTo(startLine - 1);
		for (const diffLine of hunk.diffLines) {
			if (diffLine.type === skipType) {
				continue;
			}
			const lineNumber = side === 'before' ? diffLine.oldLineNumber : diffLine.newLineNumber;
			if (lineNumber > 0) {
				padTo(lineNumber - 1);
			}
			lines.push(diffLine.text.length > 0 ? diffLine.text.slice(1) : '');
		}
	}
	return lines.join('\n') + (lines.length ? '\n' : '');
}

/**
 * Apply a unified-diff patch on top of the original full-file content to
 * produce the modified file. Adapted from the reference's
 * `getModifiedContentFromDiffHunk`, corrected for our representation where
 * `diffLine.text` retains the leading `+`/`-`/` ` prefix character.
 */
export function applyPatchToContent(originalContent: string, hunks: DiffHunk[]): string {
	const left = originalContent.split(/\r?\n/);
	const right: string[] = [];
	let lastCommonLine = 0;
	let lastDiffLineEndsWithNewline = true;

	for (let h = 0; h < hunks.length; h++) {
		const hunk = hunks[h];
		const oriStartLine = hunk.oldLineNumber;

		for (let j = lastCommonLine + 1; j < oriStartLine; j++) {
			right.push(left[j - 1]);
		}
		lastCommonLine = oriStartLine + hunk.oldLength - 1;

		for (const diffLine of hunk.diffLines) {
			if (diffLine.type === DiffChangeType.Delete || diffLine.type === DiffChangeType.Control) {
				continue;
			}
			right.push(diffLine.text.length > 0 ? diffLine.text.slice(1) : '');
		}

		if (h === hunks.length - 1) {
			for (let k = hunk.diffLines.length - 1; k >= 0; k--) {
				if (hunk.diffLines[k].type !== DiffChangeType.Delete) {
					lastDiffLineEndsWithNewline = hunk.diffLines[k].endwithLineBreak;
					break;
				}
			}
		}
	}

	if (lastDiffLineEndsWithNewline) {
		if (lastCommonLine < left.length) {
			for (let j = lastCommonLine + 1; j <= left.length; j++) {
				right.push(left[j - 1]);
			}
		}
	}

	return right.join('\n');
}
