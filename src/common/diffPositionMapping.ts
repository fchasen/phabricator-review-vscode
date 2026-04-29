/*---------------------------------------------------------------------------------------------
 *  Adapted from vscode-pull-request-github (MIT License, Copyright Microsoft Corporation).
 *--------------------------------------------------------------------------------------------*/

import { DiffChangeType, DiffHunk, parseDiffHunk } from './diffHunk';

export function getZeroBased(line: number): number {
	if (line === undefined || line === 0) {
		return 0;
	}
	return line - 1;
}

export function mapOldPositionToNew(patch: string, line: number, documentLineCount?: number): number {
	const diffReader = parseDiffHunk(patch);
	let diffIter = diffReader.next();
	let delta = 0;

	while (!diffIter.done) {
		const diffHunk: DiffHunk = diffIter.value;
		if (diffHunk.oldLineNumber > line) {
			// before this hunk
		} else if (diffHunk.oldLineNumber + diffHunk.oldLength - 1 < line) {
			delta += diffHunk.newLength - diffHunk.oldLength;
		} else if (documentLineCount === diffHunk.newLength) {
			delta += diffHunk.newLength - diffHunk.oldLength;
			return line + delta;
		} else {
			for (const diffLine of diffHunk.diffLines) {
				if (diffLine.oldLineNumber > line) {
					return line + delta;
				}
				if (diffLine.type === DiffChangeType.Add) {
					delta++;
				} else if (diffLine.type === DiffChangeType.Delete) {
					delta--;
				}
			}
			return line + delta;
		}
		diffIter = diffReader.next();
	}
	return line + delta;
}

export function mapNewPositionToOld(patch: string, line: number): number {
	const diffReader = parseDiffHunk(patch);
	let diffIter = diffReader.next();
	let delta = 0;

	while (!diffIter.done) {
		const diffHunk: DiffHunk = diffIter.value;
		if (diffHunk.newLineNumber > line) {
			// before this hunk
		} else if (diffHunk.newLineNumber + diffHunk.newLength - 1 < line) {
			delta += diffHunk.oldLength - diffHunk.newLength;
		} else {
			for (const diffLine of diffHunk.diffLines) {
				if (diffLine.type === DiffChangeType.Add) {
					delta--;
				} else if (diffLine.type === DiffChangeType.Delete) {
					delta++;
				}
				if (diffLine.newLineNumber > line) {
					return line + delta;
				}
			}
			return line + delta;
		}
		diffIter = diffReader.next();
	}
	return line + delta;
}
