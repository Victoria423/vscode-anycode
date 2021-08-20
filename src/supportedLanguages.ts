/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export class LanguageInfo {
	constructor(
		readonly languageId: string,
		readonly wasmUri: vscode.Uri,
		readonly suffixes: string[],
	) { }
}

export class SupportedLanguages {

	private readonly _onDidChange = new vscode.EventEmitter<this>();
	readonly onDidChange = this._onDidChange.event;

	private readonly _all: readonly LanguageInfo[];
	private _filteredAll: readonly LanguageInfo[] | undefined;

	private readonly _disposable: vscode.Disposable;

	constructor(context: vscode.ExtensionContext) {
		this._all = [
			new LanguageInfo('c', vscode.Uri.joinPath(context.extensionUri, 'tree-sitter-c.wasm'), ['c', 'i']),
			new LanguageInfo('cpp', vscode.Uri.joinPath(context.extensionUri, 'tree-sitter-cpp.wasm'), ['cpp', 'cc', 'cxx', 'c++', 'hpp', 'hh', 'hxx', 'h++', 'h', 'ii', 'ino', 'inl', 'ipp', 'ixx', 'hpp.in', 'h.in']),
			new LanguageInfo('csharp', vscode.Uri.joinPath(context.extensionUri, 'tree-sitter-c_sharp.wasm'), ['cs']),
			new LanguageInfo('go', vscode.Uri.joinPath(context.extensionUri, 'tree-sitter-go.wasm'), ['go']),
			new LanguageInfo('java', vscode.Uri.joinPath(context.extensionUri, 'tree-sitter-java.wasm'), ['java']),
			new LanguageInfo('php', vscode.Uri.joinPath(context.extensionUri, 'tree-sitter-php.wasm'), ['php', 'php4', 'php5', 'phtml', 'ctp']),
			new LanguageInfo('python', vscode.Uri.joinPath(context.extensionUri, 'tree-sitter-python.wasm'), ['py', 'rpy', 'pyw', 'cpy', 'gyp', 'gypi', 'pyi', 'ipy']),
			new LanguageInfo('rust', vscode.Uri.joinPath(context.extensionUri, 'tree-sitter-rust.wasm'), ['rs']),
			new LanguageInfo('typescript', vscode.Uri.joinPath(context.extensionUri, 'tree-sitter-typescript.wasm'), ['ts', 'tsx']),
		];

		// reset when extension or configuration changes
		this._disposable = vscode.Disposable.from(
			vscode.extensions.onDidChange(this._reset, this),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('anycode.language')) {
					this._reset();
				}
			})
		);
	}

	dispose(): void {
		this._onDidChange.dispose();
		this._disposable.dispose();
	}

	private _reset(): void {
		this._filteredAll = undefined;
		this._onDidChange.fire(this);
	}

	getSupportedLanguages(): readonly LanguageInfo[] {
		if (!this._filteredAll) {
			// ignore languages that well-known extensions support (when those are present)
			const wellKnownIgnored = new Set<string>();
			if (vscode.extensions.getExtension('vscode.typescript-language-features')) {
				wellKnownIgnored.add('typescript');
			}
			if (vscode.extensions.getExtension('ms-python.python')) {
				wellKnownIgnored.add('python');
			}

			const config = vscode.workspace.getConfiguration('anycode');
			this._filteredAll = this._all.filter(item => {
				if (wellKnownIgnored.has(item.languageId)) {
					return false;
				}
				if (!config.get(`language.${item.languageId}.enabled`)) {
					return false;
				}
				return true;
			});
		}
		return this._filteredAll;
	}

	getSupportedLanguagesAsSelector(): vscode.DocumentSelector {
		return this.getSupportedLanguages().map(item => item.languageId);
	}
}
