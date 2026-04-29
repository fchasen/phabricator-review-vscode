/*---------------------------------------------------------------------------------------------
 *  Adapted from vscode-pull-request-github (MIT License, Copyright Microsoft Corporation).
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Disposable } from './lifecycle';

export const REVISION_TREE = 'RevisionTree';
export const CONDUIT = 'Conduit';
export const AUTH = 'Auth';

class Log extends Disposable {
	private readonly _outputChannel: vscode.LogOutputChannel;

	constructor() {
		super();
		this._outputChannel = this._register(
			vscode.window.createOutputChannel('Mozilla Phabricator', { log: true }),
		);
	}

	private fmt(message: unknown, component?: string): string {
		let logMessage: string;
		if (typeof message === 'string') {
			logMessage = message;
		} else if (message instanceof Error) {
			logMessage = message.message + (message.stack ? `\n${message.stack}` : '');
		} else {
			try {
				logMessage = JSON.stringify(message);
			} catch {
				logMessage = String(message);
			}
		}
		return component ? `[${component}] ${logMessage}` : logMessage;
	}

	public trace(message: unknown, component?: string) {
		this._outputChannel.trace(this.fmt(message, component));
	}
	public debug(message: unknown, component?: string) {
		this._outputChannel.debug(this.fmt(message, component));
	}
	public info(message: unknown, component?: string) {
		this._outputChannel.info(this.fmt(message, component));
	}
	public warn(message: unknown, component?: string) {
		this._outputChannel.warn(this.fmt(message, component));
	}
	public error(message: unknown, component?: string) {
		this._outputChannel.error(this.fmt(message, component));
	}
}

const Logger = new Log();
export default Logger;
