/*---------------------------------------------------------------------------------------------
 *  Adapted from vscode-pull-request-github (MIT License, Copyright Microsoft Corporation).
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export function toDisposable(d: () => void): vscode.Disposable {
	return { dispose: d };
}

export function disposeAll(disposables: vscode.Disposable[]) {
	while (disposables.length) {
		const item = disposables.pop();
		item?.dispose();
	}
}

export abstract class Disposable {
	private _isDisposed = false;
	private _disposables: vscode.Disposable[] = [];

	public dispose(): void {
		if (this._isDisposed) {
			return;
		}
		this._isDisposed = true;
		disposeAll(this._disposables);
		this._disposables = [];
	}

	protected _register<T extends vscode.Disposable>(value: T): T {
		if (this._isDisposed) {
			value.dispose();
		} else {
			this._disposables.push(value);
		}
		return value;
	}

	protected get isDisposed() {
		return this._isDisposed;
	}
}
