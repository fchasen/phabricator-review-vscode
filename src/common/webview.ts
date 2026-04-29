/*---------------------------------------------------------------------------------------------
 *  Adapted from vscode-pull-request-github (MIT License, Copyright Microsoft Corporation).
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Disposable } from './lifecycle';

export const REVISION_OVERVIEW_VIEW_TYPE = 'RevisionOverview';

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
				disposable.dispose();
				resolve();
			});
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
