/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { LanguageClientOptions, RevealOutputChannelOn } from 'vscode-languageclient';
import { CommonLanguageClient } from 'vscode-languageclient';
import { SupportedLanguages } from './supportedLanguages';
import TelemetryReporter from 'vscode-extension-telemetry';
import type { InitOptions } from '../../../shared/common/initOptions';

export interface LanguageClientFactory {
	createLanguageClient(id: string, name: string, clientOptions: LanguageClientOptions): CommonLanguageClient;
	destoryLanguageClient(client: CommonLanguageClient): void;
}

export async function startClient(factory: LanguageClientFactory, context: vscode.ExtensionContext) {

	const telemetry = new TelemetryReporter(context.extension.id, context.extension.packageJSON['version'], context.extension.packageJSON['aiKey']);
	const supportedLanguages = new SupportedLanguages();

	let serverHandles: Promise<vscode.Disposable>[] = [];
	startServer();

	function startServer() {
		serverHandles.push(_startServer(factory, context, supportedLanguages, telemetry));
	}

	async function stopServers() {
		const oldHandles = serverHandles.slice(0);
		serverHandles = [];
		const result = await Promise.allSettled(oldHandles);
		for (const item of result) {
			if (item.status === 'fulfilled') {
				item.value.dispose();
			}
		}
	}

	context.subscriptions.push(supportedLanguages);
	context.subscriptions.push(supportedLanguages.onDidChange(async () => {
		// restart server when supported languages change
		await stopServers();
		startServer();
	}));

	// stop server on deactivate
	context.subscriptions.push(new vscode.Disposable(stopServers));
}

function _showStatusAndInfo(selector: vscode.DocumentSelector, showCommandHint: boolean, disposables: vscode.Disposable[]): void {

	const statusItem = vscode.languages.createLanguageStatusItem('info', selector);
	disposables.push(statusItem);
	statusItem.severity = vscode.LanguageStatusSeverity.Warning;
	statusItem.text = `Partial Mode`;
	if (showCommandHint) {
		statusItem.detail = 'Language support is inaccurate in this context. $(lightbulb-autofix) Did not index all files because search [indexing is disabled](command:remoteHub.enableIndexing).';
	} else {
		statusItem.detail = 'Language support is inaccurate in this context, results may be imprecise and incomplete.';
	}
	statusItem.command = {
		title: 'Learn More',
		command: 'vscode.open',
		arguments: [
			vscode.Uri.parse('https://aka.ms/vscode-anycode'),
		]
	};
}

async function _startServer(factory: LanguageClientFactory, context: vscode.ExtensionContext, supportedLanguagesInfo: SupportedLanguages, telemetry: TelemetryReporter): Promise<vscode.Disposable> {

	const supportedLanguages = await supportedLanguagesInfo.getSupportedLanguages();
	const documentSelector = await supportedLanguagesInfo.getSupportedLanguagesAsSelector();
	if (documentSelector.length === 0) {
		console.log('[anycode] NO supported languages, no server needed');
		// no supported languages -> nothing to do
		return new vscode.Disposable(() => { });
	}

	function _sendFeatureTelementry(name: string, language: string) {
		/* __GDPR__
			"feature" : {
				"name" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
				"language" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
			}
		*/
		telemetry.sendTelemetryEvent('feature', { name, language });
	}

	const disposables: vscode.Disposable[] = [];
	const databaseName = context.workspaceState.get('dbName', `anycode_${Math.random().toString(32).slice(2)}`);
	context.workspaceState.update('dbName', databaseName);

	// Build a glob-patterns for languages which have features enabled, like workspace symbol search, 
	// and use this pattern for initial file discovery and file watching
	const findAndSearchSuffixes: string[][] = [];
	for (const [info, config] of supportedLanguages) {
		if (config.workspaceSymbols || config.references || config.definitions) {
			findAndSearchSuffixes.push(info.suffixes);
		}
	}
	const langPattern = `**/*.{${findAndSearchSuffixes.join(',')}}`;
	const watcher = vscode.workspace.createFileSystemWatcher(langPattern);
	disposables.push(watcher);

	const treeSitterWasmUri = vscode.Uri.joinPath(context.extensionUri, './server/node_modules/web-tree-sitter/tree-sitter.wasm');
	const initializationOptions: InitOptions = {
		treeSitterWasmUri: 'importScripts' in globalThis ? treeSitterWasmUri.toString() : treeSitterWasmUri.fsPath,
		supportedLanguages: Array.from(supportedLanguages.entries()),
		databaseName
	};

	// LSP setup
	const clientOptions: LanguageClientOptions = {
		outputChannelName: 'anycode',
		revealOutputChannelOn: RevealOutputChannelOn.Never,
		documentSelector,
		synchronize: { fileEvents: watcher },
		initializationOptions,
		middleware: {
			provideWorkspaceSymbols(query, token, next) {
				_sendFeatureTelementry('workspaceSymbols', '');
				return next(query, token);
			},
			provideDefinition(document, position, token, next) {
				_sendFeatureTelementry('definition', document.languageId);
				return next(document, position, token);
			},
			provideReferences(document, position, options, token, next) {
				_sendFeatureTelementry('references', document.languageId);
				return next(document, position, options, token);
			},
			provideDocumentHighlights(document, position, token, next) {
				_sendFeatureTelementry('documentHighlights', document.languageId);
				return next(document, position, token);
			},
			provideCompletionItem(document, position, context, token, next) {
				_sendFeatureTelementry('completions', document.languageId);
				return next(document, position, context, token);
			}
		}
	};

	const client = factory.createLanguageClient('anycode', 'anycode', clientOptions);

	disposables.push(client.start());
	disposables.push(new vscode.Disposable(() => factory.destoryLanguageClient(client)));

	await client.onReady();


	// file discover and watching. in addition to text documents we annouce and provide
	// all matching files

	// workaround for https://github.com/microsoft/vscode/issues/48674
	const exclude = `{${[
		...Object.keys(vscode.workspace.getConfiguration('search', null).get('exclude') ?? {}),
		...Object.keys(vscode.workspace.getConfiguration('files', null).get('exclude') ?? {})
	].join(',')}}`;

	let size: number = Math.max(0, vscode.workspace.getConfiguration('anycode').get<number>('symbolIndexSize', 500));

	const init = Promise.resolve(vscode.workspace.findFiles(langPattern, exclude, /*unlimited to count the number of files*/).then(async all => {

		let hasWorkspaceContents = 0;
		if (all.length > 50) {
			// we have quite some files. let's check if we can read them without limits.
			// for remotehub this means try to fetch the repo-tar first
			if (await _canInitWithoutLimits()) {
				size = Number.MAX_SAFE_INTEGER;
				hasWorkspaceContents = 1;
			}
		}

		const uris = all.slice(0, size);
		console.info(`USING ${uris.length} of ${all.length} files for ${langPattern}`);

		const t1 = performance.now();
		await client.sendRequest('queue/init', uris.map(String));
		/* __GDPR__
			"init" : {
				"numOfFiles" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
				"indexSize" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
				"hasWorkspaceContents" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
				"duration" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true }
			}
		*/
		telemetry.sendTelemetryEvent('init', undefined, {
			numOfFiles: all.length, // number of files found
			indexSize: uris.length, // number of files loaded
			hasWorkspaceContents, // firehose access?
			duration: performance.now() - t1,
		});

		// show status/maybe notifications
		_showStatusAndInfo(documentSelector, !hasWorkspaceContents && _isRemoteHubWorkspace(), disposables);
	}));
	// stop on server-end
	const initCancel = new Promise<void>(resolve => disposables.push(new vscode.Disposable(resolve)));
	vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Building Index...' }, () => Promise.race([init, initCancel]));

	// serve fileRead request
	client.onRequest('file/read', async (raw: string): Promise<number[]> => {
		const uri = vscode.Uri.parse(raw);

		if (uri.scheme === 'vscode-notebook-cell') {
			// we are dealing with a notebook
			try {
				const doc = await vscode.workspace.openTextDocument(uri);
				return Array.from(new TextEncoder().encode(doc.getText()));
			} catch (err) {
				console.warn(err);
				return [];
			}
		}

		if (vscode.workspace.fs.isWritableFileSystem(uri.scheme) === undefined) {
			// undefined means we don't know anything about these uris
			return [];
		}

		let data: number[];
		try {
			const stat = await vscode.workspace.fs.stat(uri);
			if (stat.size > 1024 ** 2) {
				console.warn(`IGNORING "${uri.toString()}" because it is too large (${stat.size}bytes)`);
				data = [];
			} else {
				data = Array.from(await vscode.workspace.fs.readFile(uri));
			}
			return data;

		} catch (err) {
			// graceful
			console.warn(err);
			return [];
		}
	});


	return new vscode.Disposable(() => disposables.forEach(d => d.dispose()));
}

function _getRemoteHubExtension() {

	type RemoteHubApiStub = { loadWorkspaceContents?(workspaceUri: vscode.Uri): Promise<boolean> };
	const remoteHub = vscode.extensions.getExtension<RemoteHubApiStub>('ms-vscode.remote-repositories', true)
		?? vscode.extensions.getExtension<RemoteHubApiStub>('GitHub.remoteHub', true)
		?? vscode.extensions.getExtension<RemoteHubApiStub>('GitHub.remoteHub-insiders', true);

	return remoteHub;
}

function _isRemoteHubWorkspace() {
	if (!_getRemoteHubExtension()) {
		return false;
	}
	return vscode.workspace.workspaceFolders?.every(folder => folder.uri.scheme === 'vscode-vfs') ?? false;
}

async function _canInitWithoutLimits() {
	if (!vscode.workspace.workspaceFolders) {
		// no folder -> NO fetch
		return false;
	}

	const remoteFolders = vscode.workspace.workspaceFolders.filter(folder => folder.uri.scheme === 'vscode-vfs');

	if (remoteFolders.length === 0) {
		// no remote folders -> fetch ALL
		return true;
	}

	const remoteHub = _getRemoteHubExtension();

	const remoteHubApi = await remoteHub?.activate();
	if (typeof remoteHubApi?.loadWorkspaceContents !== 'function') {
		// no remotehub or bad version
		return false;
	}

	for (const folder of remoteFolders) {
		if (!await remoteHubApi.loadWorkspaceContents(folder.uri)) {
			// remote folder -> FAILED to load one
			return false;
		}
	}

	// remote folders, all good
	return true;
}
