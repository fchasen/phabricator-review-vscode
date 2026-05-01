/*---------------------------------------------------------------------------------------------
 *  Adapted from vscode-pull-request-github (MIT License, Copyright Microsoft Corporation).
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Disposable } from './lifecycle';
import Logger from './logger';

export const REVISION_OVERVIEW_VIEW_TYPE = 'RevisionOverview';
const READY_TIMEOUT_MS = 30_000;

export interface IRequestMessage<T> {
	req: string;
	command: string;
	args: T;
}

export interface IReplyMessage {
	seq?: string;
	err?: string;
	res?: any;
}

export abstract class WebviewBase extends Disposable {
	protected _webview?: vscode.Webview;

	private _waitForReady: Promise<void>;
	private _onIsReady: vscode.EventEmitter<void> = this._register(new vscode.EventEmitter());

	protected readonly MESSAGE_UNHANDLED = 'message not handled';

	constructor() {
		super();
		this._waitForReady = new Promise((resolve) => {
			const disposable = this._onIsReady.event(() => {
				clearTimeout(timer);
				disposable.dispose();
				resolve();
			});
			// Resolve anyway after the timeout so a broken webview can't wedge
			// the host in awaits forever; subsequent posts will simply no-op
			// against a webview that never finished mounting.
			const timer = setTimeout(() => {
				Logger.warn(`Webview did not signal ready within ${READY_TIMEOUT_MS}ms; releasing post queue.`);
				disposable.dispose();
				resolve();
			}, READY_TIMEOUT_MS);
		});
	}

	public initialize(): void {
		const disposable = this._webview?.onDidReceiveMessage(async (message) => {
			await this._onDidReceiveMessage(message as IRequestMessage<any>);
		});
		if (disposable) {
			this._register(disposable);
		}
	}

	protected async _onDidReceiveMessage(message: IRequestMessage<any>): Promise<any> {
		if (message.command === 'ready') {
			this._onIsReady.fire();
			return;
		}
		return this.MESSAGE_UNHANDLED;
	}

	protected async _postMessage(message: any) {
		await this._waitForReady;
		this._webview?.postMessage({ res: message });
	}

	protected async _replyMessage(originalMessage: IRequestMessage<any>, message: any) {
		const reply: IReplyMessage = { seq: originalMessage.req, res: message };
		await this._waitForReady;
		this._webview?.postMessage(reply);
	}

	protected async _throwError(originalMessage: IRequestMessage<any> | undefined, error: string) {
		const reply: IReplyMessage = { seq: originalMessage?.req, err: error };
		await this._waitForReady;
		this._webview?.postMessage(reply);
	}
}
