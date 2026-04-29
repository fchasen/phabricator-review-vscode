import * as vscode from 'vscode';

export const PHAB_SCHEME = 'phab';

export interface PhabUriParams {
	revisionId: number;
	revisionPHID: string;
	diffPHID: string;
	fileName: string;
	side: 'before' | 'after';
	status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied';
}

/**
 * Encode revision/diff/file metadata into a phab:// URI.
 *
 * Shape: phab://D{id}/{side}/{filename}?<urlencoded-json>
 * The JSON-in-query form mirrors how vscode-pull-request-github encodes
 * pr:// URIs and lets us round-trip every field cleanly.
 */
export function toPhabUri(params: PhabUriParams): vscode.Uri {
	const query = encodeURIComponent(JSON.stringify(params));
	return vscode.Uri.parse(`${PHAB_SCHEME}://D${params.revisionId}/${params.side}/${params.fileName}?${query}`);
}

export function fromPhabUri(uri: vscode.Uri): PhabUriParams | undefined {
	if (uri.scheme !== PHAB_SCHEME) {
		return undefined;
	}
	if (!uri.query) {
		return undefined;
	}
	try {
		return JSON.parse(decodeURIComponent(uri.query)) as PhabUriParams;
	} catch {
		return undefined;
	}
}
