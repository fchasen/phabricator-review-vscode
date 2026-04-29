/*---------------------------------------------------------------------------------------------
 *  Adapted from vscode-pull-request-github (MIT License, Copyright Microsoft Corporation).
 *--------------------------------------------------------------------------------------------*/

declare global {
	interface Window {
		acquireVsCodeApi: () => {
			postMessage(msg: any): void;
			getState(): any;
			setState(state: any): void;
		};
	}
}

const vscode = typeof window !== 'undefined' && window.acquireVsCodeApi
	? window.acquireVsCodeApi()
	: { postMessage: () => undefined, getState: () => undefined, setState: () => undefined };

let nextRequestId = 1;
const pending = new Map<string, { resolve: (v: any) => void; reject: (err: Error) => void }>();
const subscribers = new Set<(message: any) => void>();

export interface RequestEnvelope {
	req: string;
	command: string;
	args: unknown;
}

window.addEventListener('message', (event) => {
	const data = event.data || {};
	if (data.seq && pending.has(data.seq)) {
		const handler = pending.get(data.seq)!;
		pending.delete(data.seq);
		if (data.err) {
			handler.reject(new Error(data.err));
		} else {
			handler.resolve(data.res);
		}
		return;
	}
	subscribers.forEach((fn) => fn(data));
});

export function notify(command: string, args?: unknown): void {
	vscode.postMessage({ req: '', command, args });
}

export function request<T = unknown>(command: string, args?: unknown): Promise<T> {
	const req = `req-${nextRequestId++}`;
	return new Promise<T>((resolve, reject) => {
		pending.set(req, { resolve, reject });
		vscode.postMessage({ req, command, args });
	});
}

export function subscribe(fn: (message: any) => void): () => void {
	subscribers.add(fn);
	return () => subscribers.delete(fn);
}

export function ready(): void {
	vscode.postMessage({ req: '', command: 'ready', args: undefined });
}
