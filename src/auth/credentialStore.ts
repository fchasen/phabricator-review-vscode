import * as vscode from 'vscode';
import { PhabricatorClient, ConduitError } from '../client';
import { Disposable } from '../common/lifecycle';
import Logger, { AUTH } from '../common/logger';

const TOKEN_KEY = 'mozilla.phabricator.conduitToken';
const USER_PHID_MEMENTO_KEY = 'mozilla.phabricator.userPHID';
const USER_NAME_MEMENTO_KEY = 'mozilla.phabricator.userName';

export interface PhabSession {
	client: PhabricatorClient;
	userPHID: string;
	userName: string;
	realName: string;
}

export class CredentialStore extends Disposable {
	private readonly _onDidChangeSession = this._register(new vscode.EventEmitter<PhabSession | undefined>());
	public readonly onDidChangeSession = this._onDidChangeSession.event;

	private _session: PhabSession | undefined;

	constructor(
		private readonly _secrets: vscode.SecretStorage,
		private readonly _memento: vscode.Memento,
		private readonly _config: () => string,
	) {
		super();
		this._register(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('phabricator.baseUrl') && this._session) {
					Logger.info('phabricator.baseUrl changed, signing out', AUTH);
					void this.signOut();
				}
			}),
		);
	}

	public get session(): PhabSession | undefined {
		return this._session;
	}

	public async restore(): Promise<PhabSession | undefined> {
		const token = await this._secrets.get(TOKEN_KEY);
		if (!token) {
			return undefined;
		}
		try {
			return await this._activate(token);
		} catch (err) {
			Logger.warn(`Stored token failed validation: ${err instanceof Error ? err.message : err}`, AUTH);
			return undefined;
		}
	}

	public async signIn(token: string): Promise<PhabSession> {
		const session = await this._activate(token);
		await this._secrets.store(TOKEN_KEY, token);
		return session;
	}

	public async signOut(): Promise<void> {
		await this._secrets.delete(TOKEN_KEY);
		await this._memento.update(USER_PHID_MEMENTO_KEY, undefined);
		await this._memento.update(USER_NAME_MEMENTO_KEY, undefined);
		this._session = undefined;
		this._onDidChangeSession.fire(undefined);
	}

	public async ensureSession(): Promise<PhabSession | undefined> {
		if (this._session) {
			return this._session;
		}
		return this.restore();
	}

	private async _activate(token: string): Promise<PhabSession> {
		const client = new PhabricatorClient({
			token,
			baseUrl: this._config(),
			logger: (level, msg) => Logger[level](msg, 'Conduit'),
		});
		const me = await client.whoami();
		const session: PhabSession = {
			client,
			userPHID: me.phid,
			userName: me.userName,
			realName: me.realName,
		};
		this._session = session;
		await this._memento.update(USER_PHID_MEMENTO_KEY, me.phid);
		await this._memento.update(USER_NAME_MEMENTO_KEY, me.userName);
		Logger.info(`Authenticated as ${me.userName} (${me.phid})`, AUTH);
		this._onDidChangeSession.fire(session);
		return session;
	}
}

export function describeAuthError(err: unknown): string {
	if (err instanceof ConduitError) {
		return `${err.code || 'Conduit error'}${err.info ? `: ${err.info}` : ''}`;
	}
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}
