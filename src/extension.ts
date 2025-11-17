import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

type NavigationDirection = 'next' | 'previous';
type RuleOptionKey = 'matchCase' | 'matchWholeWord' | 'useRegex';
type RuleScope = 'document' | 'folder' | 'folderRecursive';

interface CreateRulePayload {
	documentUri: string;
	pattern: string;
	color: string;
	matchCase: boolean;
	matchWholeWord: boolean;
	useRegex: boolean;
	scope?: RuleScope;
	fileFilter?: string;
}

interface HighlightRule {
	id: string;
	pattern: string;
	color: string;
	matchCase: boolean;
	matchWholeWord: boolean;
	useRegex: boolean;
	decoration: vscode.TextEditorDecorationType;
	scope: RuleScope;
	targetUri: string;
	statsByDocument: Map<string, DocumentRuleStats>;
	globalMatchIndex: number | null;
	fileFilter?: string;
	filterMatchers: RegExp[] | null;
}

interface DocumentRuleStats {
	matchCount: number;
	currentMatchIndex: number | null;
	ranges: vscode.Range[];
}

interface RuleMatchLocation {
	uri: string;
	range: vscode.Range;
}

interface PanelRule {
	id: string;
	pattern: string;
	color: string;
	matchCase: boolean;
	matchWholeWord: boolean;
	useRegex: boolean;
	documentUri: string;
	scope: RuleScope;
	targetUri: string;
	fileFilter?: string;
	matchCount: number;
	currentMatchIndex: number | null;
	documentMatchCount: number;
	documentMatchIndex: number | null;
	description: string;
}

type RuleMap = Map<string, HighlightRule[]>;

interface ScopeInfo {
	scope: RuleScope;
	targetUri: string;
	key: string;
}

interface ScopeOptionDetails extends ScopeInfo {
	label: string;
	description: string;
}

interface ScopeSelectionData {
	options: ScopeOptionDetails[];
	defaultScope: RuleScope | null;
}

interface ScopeQuickPickItem extends vscode.QuickPickItem {
	scope: RuleScope;
}

interface ScopeOptionPickItem extends vscode.QuickPickItem {
	option: ScopeOptionDetails;
}

class HighlightController {
	private readonly rulesByScope: RuleMap = new Map();
	private readonly ruleIndex = new Map<string, HighlightRule>();
	private readonly documentRuleIds = new Map<string, Set<string>>();
	private readonly pendingScopeScans = new Map<string, Promise<void>>();
	private readonly pendingScopeRescanRuleIds = new Set<string>();
	private readonly onDidChangeRulesEmitter = new vscode.EventEmitter<void>();
	private static readonly defaultWordSeparators = `~!@#$%^&*()-=+[{]}\\|;:'",.<>/?`;
	private static readonly LOG_PREFIX = '[Smart Highlights]';
	private static readonly DEBUG_LOGGING_ENABLED = process.env.CONDITIONAL_COLORING_DEBUG !== '0';
	private static readonly wordSeparatorCache = new Map<string, Set<string>>();
	private static readonly wordPatternCache = new Map<string, RegExp | null>();
	private static readonly configWordPatternCache = new Map<string, RegExp | null>();
	private static readonly SCOPE_SCAN_EXCLUDES = ['**/node_modules/**', '**/.git/**', '**/out/**', '**/dist/**', '**/build/**'];
	private static readonly SCOPE_SCAN_MAX_FILES = 2000;

	private static getScopeCreationMessage(scope: RuleScope): string {
		switch (scope) {
			case 'folder':
				return 'Highlight added for this folder.';
			case 'folderRecursive':
				return 'Highlight added for this folder and its subfolders.';
			case 'document':
			default:
				return 'Highlight added to the current file.';
		}
	}

	private static describeScope(scope: RuleScope): string {
		switch (scope) {
			case 'folder':
				return 'Folder only';
			case 'folderRecursive':
				return 'Folder + subfolders';
			case 'document':
			default:
				return 'File only';
		}
	}

	public readonly onDidChangeRules = this.onDidChangeRulesEmitter.event;

	constructor(context: vscode.ExtensionContext) {
		context.subscriptions.push(
			this.onDidChangeRulesEmitter,
			vscode.workspace.onDidChangeTextDocument((event) => {
				const uri = event.document.uri.toString();
				if (this.hasRulesForDocument(event.document)) {
					this.updateDecorationsForUri(uri);
					this.notifyRulesChanged();
				}
			}),
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				if (editor) {
					this.applyRules(editor);
					this.updateCurrentMatchIndicesForEditor(editor);
				}
				this.notifyRulesChanged();
			}),
			vscode.window.onDidChangeTextEditorSelection((event) => {
				this.updateCurrentMatchIndicesForEditor(event.textEditor, event.selections);
			}),
			vscode.workspace.onDidCloseTextDocument((document) => {
				const uri = document.uri.toString();
				this.clearDocumentState(uri);
			})
		);
	}

	async addHighlightRule() {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			void vscode.window.showErrorMessage('Open a text editor before adding highlights.');
			return;
		}

		const pattern = await vscode.window.showInputBox({
			prompt: 'Enter the text or regular expression to highlight',
			placeHolder: 'Examples: FOCUS / Send Data / \\d{4}-\\d{2}-\\d{2}',
			ignoreFocusOut: true,
		});

		if (!pattern) {
			return;
		}

		if (pattern.trim() === '') {
			void vscode.window.showErrorMessage('Cannot create a highlight from an empty string.');
			return;
		}

		const options = await vscode.window.showQuickPick(
			[
				{ label: 'Match Case', picked: false, option: 'matchCase' as const },
				{ label: 'Match Whole Word', picked: false, option: 'matchWholeWord' as const },
				{ label: 'Use Regular Expression', picked: false, option: 'useRegex' as const },
			],
			{
				canPickMany: true,
				placeHolder: 'Select search options (Esc to skip)',
				ignoreFocusOut: true,
			}
		);

		const color = await vscode.window.showInputBox({
			prompt: 'Highlight color (CSS color name or #RRGGBB[AA])',
			value: '#00c4ff55',
			ignoreFocusOut: true,
		});

		if (!color) {
			return;
		}

		const scope = await this.pickScopeForNewRule(editor.document);
		if (!scope) {
			return;
		}

		const createdRule = this.createRuleFromOptions(
			editor,
			{
				pattern,
				color,
				matchCase: options?.some((option) => option.option === 'matchCase') ?? false,
				matchWholeWord: options?.some((option) => option.option === 'matchWholeWord') ?? false,
				useRegex: options?.some((option) => option.option === 'useRegex') ?? false,
				fileFilter: undefined,
			},
			scope
		);

		if (createdRule) {
			void vscode.window.showInformationMessage(HighlightController.getScopeCreationMessage(createdRule.scope));
		}
	}

	async removeHighlightRule() {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			void vscode.window.showErrorMessage('No active editor found.');
			return;
		}

		const rules = this.getRulesForDocument(editor.document);

		if (!rules || rules.length === 0) {
			void vscode.window.showInformationMessage('No highlights exist for the current file.');
			return;
		}

		const pick = await vscode.window.showQuickPick(
			rules.map((rule) => ({
				label: rule.pattern,
				description: this.describeRule(rule),
				detail: `${HighlightController.describeScope(rule.scope)} - Color: ${rule.color}`,
				rule,
			})),
			{
				placeHolder: 'Select a highlight rule to remove',
				ignoreFocusOut: true,
			}
		);

		if (!pick) {
			return;
		}

		if (this.removeRuleByInstance(pick.rule)) {
			this.notifyRulesChanged();
			void vscode.window.showInformationMessage('Highlight removed.');
		}
	}

	async clearHighlights() {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			void vscode.window.showErrorMessage('No active editor found.');
			return;
		}

		const scopeOption = await this.pickScopeForClearing(editor.document);
		if (!scopeOption) {
			void vscode.window.showInformationMessage('There are no highlights to clear.');
			return;
		}

		const rules = this.rulesByScope.get(scopeOption.key) ?? [];
		for (const rule of [...rules]) {
			this.removeRuleByInstance(rule);
		}
		this.notifyRulesChanged();
		const targetType =
			scopeOption.scope === 'folderRecursive'
				? 'folder and subfolders'
				: scopeOption.scope === 'folder'
					? 'folder'
					: 'file';
		void vscode.window.showInformationMessage(`All highlights cleared for this ${targetType}.`);
	}

	public getRuleSnapshots(uri?: string | null): PanelRule[] {
		if (!uri) {
			return [];
		}

		const targetUri = vscode.Uri.parse(uri);
		const rules = this.getRulesForUri(targetUri);
		return rules.map((rule) => {
			const stats = rule.statsByDocument.get(uri);
			const totalMatches = this.getTotalMatchCount(rule);
			return {
				id: rule.id,
				pattern: rule.pattern,
				color: rule.color,
				matchCase: rule.matchCase,
				matchWholeWord: rule.matchWholeWord,
				useRegex: rule.useRegex,
				matchCount: totalMatches,
				currentMatchIndex: rule.globalMatchIndex ?? null,
				documentMatchCount: stats?.matchCount ?? 0,
				documentMatchIndex: stats?.currentMatchIndex ?? null,
				scope: rule.scope,
				targetUri: rule.targetUri,
				fileFilter: rule.fileFilter,
				documentUri: uri,
				description: this.describeRule(rule),
			};
		});
	}

	public updateRulePattern(ruleId: string, pattern: string): boolean {
		const rule = this.ruleIndex.get(ruleId);
		if (!rule) {
			return false;
		}

		const trimmed = pattern.trim();
		if (!trimmed) {
			void vscode.window.showErrorMessage('Pattern cannot be empty.');
			return false;
		}

		try {
			this.buildRegExp(rule, trimmed);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			void vscode.window.showErrorMessage(`Invalid pattern: ${message}`);
			return false;
		}

		rule.pattern = trimmed;
		this.scheduleScopeScan(rule);
		this.refreshEditorsForRule(rule);
		this.notifyRulesChanged();
		return true;
	}

	public toggleRuleOption(ruleId: string, option: RuleOptionKey) {
		const rule = this.ruleIndex.get(ruleId);
		if (!rule) {
			return;
		}

		const previousValue = rule[option];
		rule[option] = !rule[option];

		if (rule.useRegex) {
			try {
				this.buildRegExp(rule);
			} catch (error) {
				rule[option] = previousValue;
				const message = error instanceof Error ? error.message : String(error);
				void vscode.window.showErrorMessage(`Invalid regular expression: ${message}`);
				return;
			}
		}

		this.refreshEditorsForRule(rule);
		this.scheduleScopeScan(rule);
		this.notifyRulesChanged();
	}

	public async changeRuleScope(ruleId: string, scope: RuleScope, documentUri: string): Promise<boolean> {
		const rule = this.ruleIndex.get(ruleId);
		if (!rule) {
			return false;
		}
		if (!documentUri) {
			return false;
		}
		try {
			const uri = vscode.Uri.parse(documentUri);
			const document =
				vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === documentUri) ??
				(await vscode.workspace.openTextDocument(uri));
			const scopeInfo = this.resolveScopeForDocument(document, scope);
			if (scopeInfo.scope === rule.scope && scopeInfo.targetUri === rule.targetUri) {
				return false;
			}
			this.moveRuleToScope(rule, scopeInfo);
			this.clearRuleFromAllDocuments(rule);
			this.scheduleScopeScan(rule);
			this.refreshEditorsForScope(rule.scope, rule.targetUri);
			this.notifyRulesChanged();
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(`${HighlightController.LOG_PREFIX} Failed to change rule scope`, { ruleId, message });
			return false;
		}
	}

	public updateRuleColor(ruleId: string, color: string): boolean {
		const rule = this.ruleIndex.get(ruleId);
		if (!rule) {
			return false;
		}

		const trimmed = color.trim();
		if (!trimmed) {
			void vscode.window.showErrorMessage('Color cannot be empty.');
			return false;
		}

		rule.decoration.dispose();
		rule.color = trimmed;
		rule.decoration = HighlightController.createDecoration(trimmed);
		this.refreshEditorsForRule(rule);
		this.notifyRulesChanged();
		return true;
	}

	public deleteRule(ruleId: string): boolean {
		const removed = this.removeRuleById(ruleId);
		if (removed) {
			this.notifyRulesChanged();
		}
		return removed;
	}

	public async navigateToMatch(uri: string, ruleId: string, direction: NavigationDirection) {
		const rule = this.ruleIndex.get(ruleId);
		if (!rule) {
			return;
		}

		await this.ensureScopeScan(rule);
		const matches = this.getOrderedMatches(rule);
		if (matches.length === 0) {
			void vscode.window.showInformationMessage(`No matches were found for "${rule.pattern}".`);
			return;
		}

		const activeEditor = vscode.window.activeTextEditor;
		let currentIndex: number | null = null;
		if (activeEditor) {
			const activeUri = activeEditor.document.uri.toString();
			const stats = rule.statsByDocument.get(activeUri);
			if (stats) {
				const localIndex = HighlightController.computeSelectionMatchIndex(
					activeEditor.selection,
					stats.ranges,
					activeEditor.document
				);
				const globalIndex = this.computeGlobalMatchIndex(rule, activeUri, localIndex);
				if (globalIndex && globalIndex > 0) {
					currentIndex = globalIndex - 1;
				}
			}
		}

		if (currentIndex === null && uri) {
			const stats = rule.statsByDocument.get(uri);
			const localIndex = stats?.currentMatchIndex ?? null;
			const globalIndex = this.computeGlobalMatchIndex(rule, uri, localIndex);
			if (globalIndex && globalIndex > 0) {
				currentIndex = globalIndex - 1;
			}
		}

		if (currentIndex === null && typeof rule.globalMatchIndex === 'number' && rule.globalMatchIndex > 0) {
			currentIndex = rule.globalMatchIndex - 1;
		}

		let targetIndex: number;
		if (direction === 'next') {
			targetIndex = currentIndex === null ? 0 : (currentIndex + 1) % matches.length;
		} else {
			targetIndex = currentIndex === null ? matches.length - 1 : (currentIndex - 1 + matches.length) % matches.length;
		}

		const target = matches[targetIndex];
		const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(target.uri));
		const editor = await vscode.window.showTextDocument(document, { preview: false });
		this.applyRules(editor);
		editor.selection = new vscode.Selection(target.range.start, target.range.end);
		editor.revealRange(target.range, vscode.TextEditorRevealType.InCenter);

		const localIndex = this.getLocalIndexForMatch(rule, target.uri, target.range);
		const stats = this.getOrCreateStats(rule, target.uri);
		stats.currentMatchIndex = localIndex;
		rule.globalMatchIndex = targetIndex + 1;

		this.notifyRulesChanged();
	}

	public async createRuleFromPayload(payload: CreateRulePayload) {
		const trimmedPattern = payload.pattern.trim();
		if (!trimmedPattern) {
			void vscode.window.showErrorMessage('Enter a value to highlight.');
			return;
		}

		const trimmedColor = payload.color.trim();
		if (!trimmedColor) {
			void vscode.window.showErrorMessage('Pick a highlight color.');
			return;
		}

		const documentUri = vscode.Uri.parse(payload.documentUri);
		const document =
			vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === payload.documentUri) ??
			(await vscode.workspace.openTextDocument(documentUri));
		const editor =
			vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === payload.documentUri) ??
			(await vscode.window.showTextDocument(document));

		const createdRule = this.createRuleFromOptions(
			editor,
			{
				pattern: trimmedPattern,
				color: trimmedColor,
				matchCase: payload.matchCase,
				matchWholeWord: payload.matchWholeWord,
				useRegex: payload.useRegex,
				fileFilter: payload.fileFilter,
			},
			payload.scope
		);

		if (createdRule) {
			void vscode.window.showInformationMessage(HighlightController.getScopeCreationMessage(createdRule.scope));
		}
	}

	private createRuleFromOptions(
		editor: vscode.TextEditor,
		options: Omit<CreateRulePayload, 'documentUri' | 'scope'>,
		scope?: RuleScope
	): HighlightRule | null {
		const pattern = options.pattern.trim();
		if (!pattern) {
			void vscode.window.showErrorMessage('Enter a value to highlight.');
			return null;
		}

		const color = options.color.trim();
		if (!color) {
			void vscode.window.showErrorMessage('Pick a highlight color.');
			return null;
		}

		const normalizedFilter = HighlightController.normalizeFileFilter(options.fileFilter);
		const scopeInfo = this.resolveScopeForDocument(editor.document, scope);
		const rule: HighlightRule = {
			id: HighlightController.createId(),
			pattern,
			color,
			matchCase: options.matchCase,
			matchWholeWord: options.matchWholeWord,
			useRegex: options.useRegex,
			decoration: HighlightController.createDecoration(color),
			scope: scopeInfo.scope,
			targetUri: scopeInfo.targetUri,
			statsByDocument: new Map(),
			globalMatchIndex: null,
			fileFilter: normalizedFilter,
			filterMatchers: HighlightController.createFilterMatchers(normalizedFilter),
		};

		if (rule.useRegex) {
			try {
				this.buildRegExp(rule);
			} catch (error) {
				rule.decoration.dispose();
				const message = error instanceof Error ? error.message : String(error);
				void vscode.window.showErrorMessage(`Invalid regular expression: ${message}`);
				return null;
			}
		}

		const key = scopeInfo.key;
		const rules = this.rulesByScope.get(key) ?? [];
		rules.push(rule);
		this.rulesByScope.set(key, rules);
		this.ruleIndex.set(rule.id, rule);
		this.logDebug('Created highlight rule', {
			ruleId: rule.id,
			pattern: rule.pattern,
			scope: rule.scope,
			targetUri: rule.targetUri,
			scopeKey: key,
			totalRulesForKey: rules.length,
		});
		this.scheduleScopeScan(rule);

		this.refreshEditorsForScope(rule.scope, rule.targetUri);
		this.notifyRulesChanged();
		return rule;
	}

	private moveRuleToScope(rule: HighlightRule, scopeInfo: ScopeInfo) {
		const previousKey = HighlightController.createScopeKey(rule.scope, rule.targetUri);
		const previousRules = this.rulesByScope.get(previousKey);
		if (previousRules) {
			const index = previousRules.findIndex((candidate) => candidate.id === rule.id);
			if (index !== -1) {
				previousRules.splice(index, 1);
			}
			if (previousRules.length === 0) {
				this.rulesByScope.delete(previousKey);
			}
		}

		rule.scope = scopeInfo.scope;
		rule.targetUri = scopeInfo.targetUri;

		const nextKey = scopeInfo.key;
		const nextRules = this.rulesByScope.get(nextKey) ?? [];
		if (!this.rulesByScope.has(nextKey)) {
			this.rulesByScope.set(nextKey, nextRules);
		}
		nextRules.push(rule);

		this.logDebug('Moved rule to new scope', {
			ruleId: rule.id,
			scope: rule.scope,
			targetUri: rule.targetUri,
			previousKey,
			nextKey,
		});
	}

	private notifyRulesChanged() {
		this.onDidChangeRulesEmitter.fire();
	}

	private removeRuleById(ruleId: string): boolean {
		const rule = this.ruleIndex.get(ruleId);
		if (!rule) {
			return false;
		}
		return this.removeRuleByInstance(rule);
	}

	private removeRuleByInstance(rule: HighlightRule): boolean {
		const key = HighlightController.createScopeKey(rule.scope, rule.targetUri);
		const rules = this.rulesByScope.get(key);
		if (!rules) {
			this.logDebug('Attempted to remove rule but scope entry missing', { ruleId: rule.id, scopeKey: key });
			return false;
		}

		const index = rules.findIndex((candidate) => candidate.id === rule.id);
		if (index === -1) {
			this.logDebug('Attempted to remove rule not found under key', { ruleId: rule.id, scopeKey: key });
			return false;
		}

		rules.splice(index, 1);
		if (rules.length === 0) {
			this.rulesByScope.delete(key);
		}

		this.ruleIndex.delete(rule.id);
		this.clearRuleFromAllDocuments(rule);
		rule.decoration.dispose();
		this.logDebug('Removed highlight rule', {
			ruleId: rule.id,
			scope: rule.scope,
			targetUri: rule.targetUri,
			scopeKey: key,
			remainingRulesForKey: rules.length,
		});
		this.refreshEditorsForScope(rule.scope, rule.targetUri);
		return true;
	}

	private applyRules(editor: vscode.TextEditor) {
		const document = editor.document;
		const uri = document.uri.toString();
		const rules = this.getRulesForDocument(document);
		const previousRuleIds = this.documentRuleIds.get(uri) ?? new Set<string>();
		const nextRuleIds = new Set<string>();

		this.logDebug('Applying rules to document', {
			documentUri: uri,
			ruleCount: rules.length,
			activeEditor: editor === vscode.window.activeTextEditor,
		});

		if (rules.length === 0) {
			for (const ruleId of previousRuleIds) {
				const rule = this.ruleIndex.get(ruleId);
				if (rule) {
					editor.setDecorations(rule.decoration, []);
					rule.statsByDocument.delete(uri);
				}
			}
			this.documentRuleIds.delete(uri);
			return;
		}

		for (const rule of rules) {
			const ranges = this.findMatches(document, rule);
			const stats = this.getOrCreateStats(rule, uri);
			stats.matchCount = ranges.length;
			stats.ranges = ranges;
			if (ranges.length === 0) {
				stats.currentMatchIndex = null;
			} else if (editor === vscode.window.activeTextEditor) {
				stats.currentMatchIndex = HighlightController.computeSelectionMatchIndex(
					editor.selection,
					ranges,
					document
				);
			} else {
				stats.currentMatchIndex = null;
			}
			editor.setDecorations(rule.decoration, ranges);
			nextRuleIds.add(rule.id);
			this.logDebug('Applied individual rule to document', {
				documentUri: uri,
				ruleId: rule.id,
				scope: rule.scope,
				targetUri: rule.targetUri,
				matchCount: ranges.length,
			});
		}

		for (const ruleId of previousRuleIds) {
			if (!nextRuleIds.has(ruleId)) {
				const rule = this.ruleIndex.get(ruleId);
				if (rule) {
					editor.setDecorations(rule.decoration, []);
					rule.statsByDocument.delete(uri);
				}
			}
		}

		if (nextRuleIds.size === 0) {
			this.documentRuleIds.delete(uri);
		} else {
			this.documentRuleIds.set(uri, nextRuleIds);
		}
	}

	private updateCurrentMatchIndicesForEditor(
		editor: vscode.TextEditor,
		selections?: readonly vscode.Selection[]
	) {
		const document = editor.document;
		const uri = document.uri.toString();
		const rules = this.getRulesForDocument(document);
		if (rules.length === 0) {
			return;
		}

		const selection = selections?.[0] ?? editor.selection;
		let changed = false;

		for (const rule of rules) {
			const stats = this.getOrCreateStats(rule, uri);
			if (stats.ranges.length === 0 && stats.matchCount > 0) {
				const ranges = this.findMatches(document, rule);
				stats.ranges = ranges;
				stats.matchCount = ranges.length;
			}

			const ranges = stats.ranges;
			const index = HighlightController.computeSelectionMatchIndex(
				selection,
				ranges,
				document
			);
			if (stats.currentMatchIndex !== index) {
				stats.currentMatchIndex = index;
				changed = true;
			}
			const globalIndex = this.computeGlobalMatchIndex(rule, uri, index);
			if (rule.globalMatchIndex !== globalIndex) {
				rule.globalMatchIndex = globalIndex;
				changed = true;
			}
		}

		if (changed) {
			this.notifyRulesChanged();
		}
	}

	private updateDecorationsForUri(uri: string) {
		const editors = vscode.window.visibleTextEditors.filter((editor) => editor.document.uri.toString() === uri);
		for (const editor of editors) {
			this.applyRules(editor);
		}
	}

	private findMatches(document: vscode.TextDocument, rule: HighlightRule): vscode.Range[] {
		const regex = this.buildRegExp(rule);
		const ranges: vscode.Range[] = [];
		const text = document.getText();
		let match: RegExpExecArray | null;

		while ((match = regex.exec(text)) !== null) {
			if (match[0].length === 0) {
				regex.lastIndex += 1;
				continue;
			}

			const start = document.positionAt(match.index);
			const end = document.positionAt(match.index + match[0].length);
			const range = new vscode.Range(start, end);
			if (rule.matchWholeWord && !this.isWholeWordMatch(document, range, text)) {
				continue;
			}
			ranges.push(range);
		}

		return ranges;
	}

	private static computeSelectionMatchIndex(
		selection: vscode.Selection | undefined,
		ranges: vscode.Range[],
		document: vscode.TextDocument
	): number | null {
		if (!selection || ranges.length === 0) {
			return null;
		}

		const selectionStart = document.offsetAt(selection.start);
		const selectionEnd = document.offsetAt(selection.end);
		const isEmpty = selection.isEmpty;

		for (let i = 0; i < ranges.length; i += 1) {
			const range = ranges[i];
			const rangeStart = document.offsetAt(range.start);
			const rangeEnd = document.offsetAt(range.end);

			if (!isEmpty) {
				const matchesExactly = rangeStart === selectionStart && rangeEnd === selectionEnd;
				const fullyContains = selectionStart <= rangeStart && selectionEnd >= rangeEnd;
				if (matchesExactly || fullyContains) {
					return i + 1;
				}
				continue;
			}

			const position = selectionStart;
			if (position >= rangeStart && position <= rangeEnd) {
				return i + 1;
			}
		}

		return null;
	}

	private buildRegExp(rule: HighlightRule, overridePattern?: string): RegExp {
		const sourcePattern = overridePattern ?? rule.pattern;
		const source = rule.useRegex
			? sourcePattern
			: HighlightController.escapeForRegExp(sourcePattern);
		const flags = `g${rule.matchCase ? '' : 'i'}`;
		return new RegExp(source, flags);
	}

	private describeRule(rule: HighlightRule): string {
		const parts: string[] = [];
		if (rule.matchCase) {
			parts.push('Match Case');
		}
		if (rule.matchWholeWord) {
			parts.push('Whole Word');
		}
		if (rule.useRegex) {
			parts.push('Regex');
		}

		return parts.length > 0 ? parts.join(' / ') : 'No options';
	}

	private clearRuleFromAllDocuments(rule: HighlightRule) {
		for (const documentUri of [...rule.statsByDocument.keys()]) {
			this.removeRuleFromDocument(rule, documentUri);
		}
	}

	private scheduleScopeScan(rule: HighlightRule) {
		if (rule.scope === 'document') {
			return;
		}
		if (this.pendingScopeScans.has(rule.id)) {
			this.pendingScopeRescanRuleIds.add(rule.id);
			return;
		}

		const promise = this.performScopeScan(rule)
			.catch((error) => {
				console.warn(`${HighlightController.LOG_PREFIX} Failed to scan scope`, error);
			})
			.finally(() => {
				this.pendingScopeScans.delete(rule.id);
				if (this.pendingScopeRescanRuleIds.delete(rule.id)) {
					this.scheduleScopeScan(rule);
				}
			});
		this.pendingScopeScans.set(rule.id, promise);
	}

	private async ensureScopeScan(rule: HighlightRule): Promise<void> {
		if (rule.scope === 'document') {
			return;
		}
		this.scheduleScopeScan(rule);
		const pending = this.pendingScopeScans.get(rule.id);
		if (pending) {
			await pending;
		}
	}

	private async performScopeScan(rule: HighlightRule): Promise<void> {
		const uris = await this.collectUrisForRuleScope(rule);
		const filteredUris = uris.filter((uri) => this.isFileIncluded(rule, uri));
		let processed = 0;
		for (const uri of filteredUris) {
			await this.scanRuleInUri(rule, uri);
			processed += 1;
		}
		rule.globalMatchIndex = null;
		this.logDebug('Completed scope scan', {
			ruleId: rule.id,
			scope: rule.scope,
			targetUri: rule.targetUri,
			filesProcessed: processed,
		});
		this.notifyRulesChanged();
	}

	private static getScopeExcludePattern(): string | undefined {
		if (HighlightController.SCOPE_SCAN_EXCLUDES.length === 0) {
			return undefined;
		}
		return `{${HighlightController.SCOPE_SCAN_EXCLUDES.join(',')}}`;
	}

	private async collectUrisForRuleScope(rule: HighlightRule): Promise<vscode.Uri[]> {
		try {
			if (rule.scope === 'document') {
				return [vscode.Uri.parse(rule.targetUri)];
			}

			const folderUri = vscode.Uri.parse(rule.targetUri);
			if (rule.scope === 'folder') {
				return this.readImmediateFiles(folderUri);
			}

			return this.readRecursiveFiles(folderUri);
		} catch (error) {
			this.logDebug('Failed to enumerate files for scope', {
				ruleId: rule.id,
				scope: rule.scope,
				targetUri: rule.targetUri,
				error: error instanceof Error ? error.message : String(error),
			});
			return [];
		}
	}

	private async readImmediateFiles(folderUri: vscode.Uri): Promise<vscode.Uri[]> {
		const entries = await vscode.workspace.fs.readDirectory(folderUri);
		const result: vscode.Uri[] = [];
		for (const [name, type] of entries) {
			if (type === vscode.FileType.File) {
				result.push(vscode.Uri.joinPath(folderUri, name));
			}
		}
		return result;
	}

	private async readRecursiveFiles(folderUri: vscode.Uri): Promise<vscode.Uri[]> {
		const exclude = HighlightController.getScopeExcludePattern();
		const pattern = new vscode.RelativePattern(folderUri, '**/*');
		return vscode.workspace.findFiles(pattern, exclude, HighlightController.SCOPE_SCAN_MAX_FILES);
	}

	private async scanRuleInUri(rule: HighlightRule, uri: vscode.Uri): Promise<void> {
		try {
			if (!this.isFileIncluded(rule, uri)) {
				return;
			}
			const document = await vscode.workspace.openTextDocument(uri);
			const ranges = this.findMatches(document, rule);
			const key = uri.toString();
			if (ranges.length === 0) {
				if (rule.statsByDocument.has(key)) {
					rule.statsByDocument.delete(key);
				}
				return;
			}
			const stats = this.getOrCreateStats(rule, key);
			stats.matchCount = ranges.length;
			stats.ranges = ranges;
			stats.currentMatchIndex = null;
		} catch (error) {
			this.logDebug('Skipped file during scope scan', {
				ruleId: rule.id,
				file: uri.toString(),
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private getTotalMatchCount(rule: HighlightRule): number {
		let total = 0;
		for (const stats of rule.statsByDocument.values()) {
			total += stats.matchCount;
		}
		return total;
	}

	private getOrderedMatches(rule: HighlightRule): RuleMatchLocation[] {
		const entries = [...rule.statsByDocument.entries()].sort(([uriA], [uriB]) =>
			uriA.localeCompare(uriB)
		);
		const matches: RuleMatchLocation[] = [];
		for (const [uri, stats] of entries) {
			const orderedRanges = [...stats.ranges].sort(HighlightController.compareRanges);
			for (const range of orderedRanges) {
				matches.push({ uri, range });
			}
		}
		return matches;
	}

	private computeGlobalMatchIndex(rule: HighlightRule, uri: string, localIndex: number | null): number | null {
		if (!localIndex || localIndex <= 0) {
			return null;
		}
		const entries = [...rule.statsByDocument.entries()].sort(([uriA], [uriB]) =>
			uriA.localeCompare(uriB)
		);
		let offset = 0;
		for (const [entryUri, stats] of entries) {
			if (entryUri === uri) {
				if (localIndex > stats.matchCount) {
					return null;
				}
				return offset + localIndex;
			}
			offset += stats.matchCount;
		}
		return null;
	}

	private static compareRanges(a: vscode.Range, b: vscode.Range): number {
		if (a.start.line !== b.start.line) {
			return a.start.line - b.start.line;
		}
		if (a.start.character !== b.start.character) {
			return a.start.character - b.start.character;
		}
		if (a.end.line !== b.end.line) {
			return a.end.line - b.end.line;
		}
		return a.end.character - b.end.character;
	}

	private getLocalIndexForMatch(rule: HighlightRule, uri: string, range: vscode.Range): number | null {
		const stats = rule.statsByDocument.get(uri);
		if (!stats) {
			return null;
		}
		const index = stats.ranges.findIndex((candidate) => candidate.isEqual(range));
		return index === -1 ? null : index + 1;
	}

	private isFileIncluded(rule: HighlightRule, uri: vscode.Uri): boolean {
		if (!rule.filterMatchers || rule.filterMatchers.length === 0) {
			return true;
		}
		const fileName = HighlightController.getFileNameForUri(uri);
		return rule.filterMatchers.some((matcher) => matcher.test(fileName));
	}

	private removeRuleFromDocument(rule: HighlightRule, documentUri: string) {
		const editors = vscode.window.visibleTextEditors.filter(
			(editor) => editor.document.uri.toString() === documentUri
		);
		for (const editor of editors) {
			editor.setDecorations(rule.decoration, []);
		}
		rule.statsByDocument.delete(documentUri);
		const ruleIds = this.documentRuleIds.get(documentUri);
		if (ruleIds) {
			ruleIds.delete(rule.id);
			if (ruleIds.size === 0) {
				this.documentRuleIds.delete(documentUri);
			}
		}
	}

	private static createScopeKey(scope: RuleScope, targetUri: string): string {
		return `${scope}:${targetUri}`;
	}

	private static getContainingFolderUri(uri: vscode.Uri): vscode.Uri | null {
		if (uri.scheme !== 'file') {
			return null;
		}
		const dir = path.dirname(uri.fsPath);
		if (!dir || dir === uri.fsPath) {
			return null;
		}
		return vscode.Uri.file(dir);
	}

	private static getParentFolderUri(folderUri: vscode.Uri): vscode.Uri | null {
		if (folderUri.scheme !== 'file') {
			return null;
		}
		const parent = path.dirname(folderUri.fsPath);
		if (!parent || parent === folderUri.fsPath) {
			return null;
		}
		return vscode.Uri.file(parent);
	}

	private static getFolderHierarchyForUri(uri: vscode.Uri): vscode.Uri[] {
		const folders: vscode.Uri[] = [];
		let current = HighlightController.getContainingFolderUri(uri);
		let safety = 0;
		while (current && safety < 50) {
			folders.push(current);
			current = HighlightController.getParentFolderUri(current);
			safety += 1;
		}
		return folders;
	}

	private static normalizeUriForComparison(uri: vscode.Uri): string {
		if (uri.scheme === 'file') {
			const normalized = path.resolve(uri.fsPath);
			return normalized.replace(/\\/g, '/').toLowerCase();
		}
		return uri.toString().toLowerCase();
	}

	private static areUrisEqual(a: vscode.Uri, b: vscode.Uri): boolean {
		return HighlightController.normalizeUriForComparison(a) === HighlightController.normalizeUriForComparison(b);
	}

	private static isDescendantUri(candidate: vscode.Uri, folder: vscode.Uri): boolean {
		const candidatePath = HighlightController.normalizeUriForComparison(candidate);
		const folderPath = HighlightController.normalizeUriForComparison(folder).replace(/\/+$/, '');
		if (candidatePath === folderPath) {
			return true;
		}
		return candidatePath.startsWith(folderPath + '/');
	}

	private static getFolderLabel(folderUri: vscode.Uri): string {
		if (folderUri.scheme !== 'file') {
			return folderUri.toString();
		}
		const base = path.basename(folderUri.fsPath);
		return base || folderUri.fsPath;
	}

	private static normalizeFileFilter(value?: string): string | undefined {
		if (!value) {
			return undefined;
		}
		const normalized = value
			.split('|')
			.map((part) => part.trim())
			.filter((part) => part.length > 0)
			.join('|');
		return normalized || undefined;
	}

	private static createFilterMatchers(value?: string): RegExp[] | null {
		if (!value) {
			return null;
		}
		const patterns = value
			.split('|')
			.map((part) => part.trim())
			.filter((part) => part.length > 0);
		if (patterns.length === 0) {
			return null;
		}
		const matchers: RegExp[] = [];
		for (const pattern of patterns) {
			const regex = HighlightController.globToRegExp(pattern);
			if (regex) {
				matchers.push(regex);
			}
		}
		return matchers.length > 0 ? matchers : null;
	}

	private static globToRegExp(pattern: string): RegExp | null {
		const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
		const source = '^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
		try {
			return new RegExp(source, 'i');
		} catch {
			return null;
		}
	}

	private static getFileNameForUri(uri: vscode.Uri): string {
		if (uri.scheme === 'file') {
			return path.basename(uri.fsPath);
		}
		const segments = uri.path.split('/');
		return segments[segments.length - 1] || uri.path || uri.toString();
	}

	private resolveScopeForDocument(document: vscode.TextDocument, preferredScope?: RuleScope): ScopeInfo {
		const documentTarget = document.uri.toString();
		const documentInfo: ScopeInfo = {
			scope: 'document',
			targetUri: documentTarget,
			key: HighlightController.createScopeKey('document', documentTarget),
		};

		const folderUri = HighlightController.getContainingFolderUri(document.uri);
		const folderInfo: ScopeInfo | null = folderUri
			? {
					scope: 'folder',
					targetUri: folderUri.toString(),
					key: HighlightController.createScopeKey('folder', folderUri.toString()),
			  }
			: null;

		const folderRecursiveInfo: ScopeInfo | null = folderUri
			? {
					scope: 'folderRecursive',
					targetUri: folderUri.toString(),
					key: HighlightController.createScopeKey('folderRecursive', folderUri.toString()),
			  }
			: null;

		const resolvePreferred = (scope: RuleScope): ScopeInfo => {
			switch (scope) {
				case 'folderRecursive':
					if (folderRecursiveInfo) {
						return folderRecursiveInfo;
					}
					break;
				case 'folder':
					if (folderInfo) {
						return folderInfo;
					}
					break;
				case 'document':
				default:
					return documentInfo;
			}
			return documentInfo;
		};

		if (preferredScope) {
			return resolvePreferred(preferredScope);
		}

		if (folderRecursiveInfo) {
			return folderRecursiveInfo;
		}

		return documentInfo;
	}

	private getScopeOptionsForDocument(document: vscode.TextDocument): ScopeOptionDetails[] {
		const options: ScopeOptionDetails[] = [];
		const documentInfo = this.resolveScopeForDocument(document, 'document');
		options.push({
			...documentInfo,
			label: 'Current File',
			description: path.basename(document.fileName),
		});

		const folderUri = HighlightController.getContainingFolderUri(document.uri);
		if (folderUri) {
			const folderInfo = this.resolveScopeForDocument(document, 'folder');
			options.push({
				...folderInfo,
				label: 'Current Folder',
				description: HighlightController.getFolderLabel(folderUri),
			});
			const folderRecursiveInfo = this.resolveScopeForDocument(document, 'folderRecursive');
			options.push({
				...folderRecursiveInfo,
				label: 'Folder + Subfolders',
				description: HighlightController.getFolderLabel(folderUri),
			});
		}

		return options;
	}

	public getScopeSelectionData(document?: vscode.TextDocument | null): ScopeSelectionData {
		if (!document) {
			return { options: [], defaultScope: null };
		}
		const options = this.getScopeOptionsForDocument(document);
		const defaultScope = this.resolveScopeForDocument(document).scope;
		return { options, defaultScope };
	}

	private async pickScopeForNewRule(document: vscode.TextDocument): Promise<RuleScope | undefined> {
		const options = this.getScopeOptionsForDocument(document);
		if (options.length === 0) {
			return undefined;
		}
		if (options.length === 1) {
			return options[0].scope;
		}
		const defaultScope = this.resolveScopeForDocument(document).scope;
		const selection = await vscode.window.showQuickPick(
			options.map<ScopeQuickPickItem>((option) => ({
				label: option.label,
				description: option.description,
				scope: option.scope,
				picked: option.scope === defaultScope,
			})),
			{
				placeHolder: 'Choose where this highlight should apply',
				ignoreFocusOut: true,
			}
		);
		return selection?.scope;
	}

	private async pickScopeForClearing(document: vscode.TextDocument): Promise<ScopeOptionDetails | null> {
		const options = this.getScopeOptionsForDocument(document);
		const withRules = options
			.map((option) => ({
				option,
				count: this.rulesByScope.get(option.key)?.length ?? 0,
			}))
			.filter((entry) => entry.count > 0);

		if (withRules.length === 0) {
			return null;
		}

		if (withRules.length === 1) {
			return withRules[0].option;
		}

		const selection = await vscode.window.showQuickPick(
			withRules.map<ScopeOptionPickItem>((entry) => ({
				label: entry.option.label,
				description: `${entry.option.description} (${entry.count} rules)`,
				option: entry.option,
			})),
			{
				placeHolder: 'Select which scope to clear',
				ignoreFocusOut: true,
			}
		);

		return selection?.option ?? null;
	}

	private getScopeKeysForUri(uri: vscode.Uri): string[] {
		const keys: string[] = [];
		keys.push(HighlightController.createScopeKey('document', uri.toString()));
		const folders = HighlightController.getFolderHierarchyForUri(uri);
		if (folders.length > 0) {
			const immediate = folders[0];
			keys.push(HighlightController.createScopeKey('folder', immediate.toString()));
			for (const folder of folders) {
				keys.push(HighlightController.createScopeKey('folderRecursive', folder.toString()));
			}
		}
		return keys;
	}

	private getRulesForUri(uri: vscode.Uri): HighlightRule[] {
		const keys = this.getScopeKeysForUri(uri);
		const result: HighlightRule[] = [];
		const countsByKey: Record<string, number> = {};
		for (const key of keys) {
			const rules = this.rulesByScope.get(key);
			countsByKey[key] = rules?.length ?? 0;
			if (rules && rules.length > 0) {
				result.push(...rules);
			}
		}
		const filtered = result.filter((rule) => this.isFileIncluded(rule, uri));
		this.logDebug('Resolved rules for URI', {
			documentUri: uri.toString(),
			scopeKeys: keys,
			countsByKey,
			totalRules: filtered.length,
		});
		return filtered;
	}

	private getRulesForDocument(document: vscode.TextDocument): HighlightRule[] {
		return this.getRulesForUri(document.uri);
	}

	private hasRulesForDocument(document: vscode.TextDocument): boolean {
		return this.getRulesForDocument(document).length > 0;
	}

	private getOrCreateStats(rule: HighlightRule, documentUri: string): DocumentRuleStats {
		let stats = rule.statsByDocument.get(documentUri);
		if (!stats) {
			stats = { matchCount: 0, currentMatchIndex: null, ranges: [] };
			rule.statsByDocument.set(documentUri, stats);
		}
		return stats;
	}

	private refreshEditorsForRule(rule: HighlightRule) {
		this.refreshEditorsForScope(rule.scope, rule.targetUri);
	}

	private refreshEditorsForScope(scope: RuleScope, targetUri: string) {
		this.logDebug('Refreshing editors for scope', {
			scope,
			targetUri,
			visibleEditors: vscode.window.visibleTextEditors.map((editor) => editor.document.uri.toString()),
		});
		for (const editor of vscode.window.visibleTextEditors) {
			if (this.doesScopeApplyToDocument(scope, targetUri, editor.document)) {
				this.applyRules(editor);
			}
		}
	}

	private doesScopeApplyToDocument(scope: RuleScope, targetUri: string, document: vscode.TextDocument): boolean {
		if (scope === 'document') {
			return document.uri.toString() === targetUri;
		}
		const folderUri = HighlightController.getContainingFolderUri(document.uri);
		if (!folderUri) {
			return false;
		}
		const target = vscode.Uri.parse(targetUri);
		if (scope === 'folder') {
			return HighlightController.areUrisEqual(folderUri, target);
		}
		if (scope === 'folderRecursive') {
			return HighlightController.isDescendantUri(folderUri, target);
		}
		return false;
	}

	private clearDocumentState(documentUri: string) {
		const appliedRuleIds = this.documentRuleIds.get(documentUri);
		if (!appliedRuleIds || appliedRuleIds.size === 0) {
			return;
		}
		const editors = vscode.window.visibleTextEditors.filter(
			(editor) => editor.document.uri.toString() === documentUri
		);
		for (const ruleId of appliedRuleIds) {
			const rule = this.ruleIndex.get(ruleId);
			if (!rule) {
				continue;
			}
			if (rule.scope === 'document') {
				rule.statsByDocument.delete(documentUri);
			} else {
				const stats = rule.statsByDocument.get(documentUri);
				if (stats) {
					stats.currentMatchIndex = null;
				}
			}
			for (const editor of editors) {
				editor.setDecorations(rule.decoration, []);
			}
		}
		this.documentRuleIds.delete(documentUri);
	}

	private static createDecoration(color: string): vscode.TextEditorDecorationType {
		const textColor = HighlightController.getReadableTextColor(color);
		return vscode.window.createTextEditorDecorationType({
			backgroundColor: color,
			border: `1px solid ${color}`,
			borderRadius: '2px',
			color: textColor,
			overviewRulerColor: color,
			overviewRulerLane: vscode.OverviewRulerLane.Right,
		});
	}

	private static createId(): string {
		return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
	}

	private static escapeForRegExp(value: string): string {
		return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	private isWholeWordMatch(document: vscode.TextDocument, range: vscode.Range, fullText: string): boolean {
		const wordPattern = HighlightController.getLanguageWordPattern(document);
		if (wordPattern) {
			const wordRange = document.getWordRangeAtPosition(range.start, wordPattern);
			return Boolean(wordRange && wordRange.isEqual(range));
		}
		return HighlightController.matchesWordSeparators(document, range, fullText);
	}

	private static matchesWordSeparators(
		document: vscode.TextDocument,
		range: vscode.Range,
		fullText: string
	): boolean {
		const separators = HighlightController.getWordSeparators(document);
		const startOffset = document.offsetAt(range.start);
		const endOffset = document.offsetAt(range.end);
		const beforeChar = startOffset > 0 ? fullText[startOffset - 1] : '';
		const afterChar = endOffset < fullText.length ? fullText[endOffset] : '';
		return (
			!HighlightController.isWordCharacter(beforeChar, separators) &&
			!HighlightController.isWordCharacter(afterChar, separators)
		);
	}

	private static isWordCharacter(char: string | undefined, separators: Set<string>): boolean {
		if (!char) {
			return false;
		}
		if (/\s/.test(char)) {
			return false;
		}
		return !separators.has(char);
	}

	private static getWordSeparators(document: vscode.TextDocument): Set<string> {
		const separatorValue =
			vscode.workspace.getConfiguration('editor', document).get<string>('wordSeparators') ??
			HighlightController.defaultWordSeparators;
		let cached = HighlightController.wordSeparatorCache.get(separatorValue);
		if (!cached) {
			cached = new Set(separatorValue.split(''));
			HighlightController.wordSeparatorCache.set(separatorValue, cached);
		}
		return cached;
	}

	private static getLanguageWordPattern(document: vscode.TextDocument): RegExp | null {
		const languageId = document.languageId;
		if (HighlightController.wordPatternCache.has(languageId)) {
			return HighlightController.wordPatternCache.get(languageId) ?? null;
		}
		const pattern = HighlightController.loadWordPatternForLanguage(languageId);
		HighlightController.wordPatternCache.set(languageId, pattern ?? null);
		return pattern ?? null;
	}

	private static loadWordPatternForLanguage(languageId: string): RegExp | null {
		for (const extension of vscode.extensions.all) {
			const contributes = extension.packageJSON?.contributes;
			if (!contributes) {
				continue;
			}
			const languages = Array.isArray(contributes.languages) ? contributes.languages : [];
			for (const language of languages) {
				if (language?.id !== languageId || !language.configuration) {
					continue;
				}
				const configPath = path.join(extension.extensionPath, language.configuration);
				const pattern = HighlightController.getWordPatternFromConfig(configPath);
				if (pattern) {
					return pattern;
				}
			}
		}
		return null;
	}

	private static getWordPatternFromConfig(configPath: string): RegExp | null {
		if (HighlightController.configWordPatternCache.has(configPath)) {
			return HighlightController.configWordPatternCache.get(configPath) ?? null;
		}

		try {
			if (!fs.existsSync(configPath)) {
				HighlightController.configWordPatternCache.set(configPath, null);
				return null;
			}

			let config: unknown;
			const lowerPath = configPath.toLowerCase();
			if (lowerPath.endsWith('.json') || lowerPath.endsWith('.jsonc')) {
				const raw = fs.readFileSync(configPath, 'utf8');
				config = JSON.parse(HighlightController.stripJsonComments(raw));
			} else {
				const required = require(configPath);
				config = (required as { default?: unknown })?.default ?? required;
			}

			const pattern = HighlightController.extractWordPattern(config);
			HighlightController.configWordPatternCache.set(configPath, pattern ?? null);
			return pattern ?? null;
		} catch (error) {
			console.warn(`[Smart Highlights] Failed to read wordPattern from ${configPath}:`, error);
			HighlightController.configWordPatternCache.set(configPath, null);
			return null;
		}
	}

	private static extractWordPattern(config: unknown): RegExp | null {
		if (!config || typeof config !== 'object') {
			return null;
		}
		const rawPattern = (config as { wordPattern?: unknown }).wordPattern;
		if (!rawPattern) {
			return null;
		}
		if (typeof rawPattern === 'string') {
			return new RegExp(rawPattern);
		}
		if (typeof rawPattern === 'object') {
			const pattern = (rawPattern as { pattern?: unknown }).pattern;
			if (typeof pattern === 'string') {
				const flags = typeof (rawPattern as { flags?: unknown }).flags === 'string' ? (rawPattern as { flags: string }).flags : '';
				return new RegExp(pattern, flags);
			}
		}
		return null;
	}

	private static stripJsonComments(content: string): string {
		let output = '';
		let inString = false;
		let stringDelimiter: string | null = null;
		let inLineComment = false;
		let inBlockComment = false;

		for (let i = 0; i < content.length; i += 1) {
			const char = content[i];
			const next = content[i + 1];

			if (inLineComment) {
				if (char === '\n') {
					inLineComment = false;
					output += char;
				}
				continue;
			}

			if (inBlockComment) {
				if (char === '*' && next === '/') {
					inBlockComment = false;
					i += 1;
				}
				continue;
			}

			if (inString) {
				if (char === '\\') {
					output += char;
					i += 1;
					if (i < content.length) {
						output += content[i];
					}
					continue;
				}

				if (char === stringDelimiter) {
					inString = false;
					stringDelimiter = null;
				}

				output += char;
				continue;
			}

			if (char === '"' || char === "'" || char === '`') {
				inString = true;
				stringDelimiter = char;
				output += char;
				continue;
			}

			if (char === '/' && next === '/') {
				inLineComment = true;
				i += 1;
				continue;
			}

			if (char === '/' && next === '*') {
				inBlockComment = true;
				i += 1;
				continue;
			}

			output += char;
		}

		return output;
	}

	private static getReadableTextColor(color: string): string | undefined {
		const rgb = HighlightController.parseHexColor(color);
		if (!rgb) {
			return undefined;
		}

		const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
		return luminance > 0.6 ? '#1f1f1f' : '#ffffff';
	}

	private logDebug(message: string, data?: Record<string, unknown>) {
		if (!HighlightController.DEBUG_LOGGING_ENABLED) {
			return;
		}
		if (data) {
			console.log(`${HighlightController.LOG_PREFIX} ${message}`, data);
		} else {
			console.log(`${HighlightController.LOG_PREFIX} ${message}`);
		}
	}

	private static parseHexColor(value: string): { r: number; g: number; b: number } | undefined {
		const trimmed = value.trim();
		if (!trimmed.startsWith('#')) {
			return undefined;
		}

		let hex = trimmed.slice(1);
		if (hex.length === 3 || hex.length === 4) {
			hex = hex
				.slice(0, 3)
				.split('')
				.map((char) => char + char)
				.join('');
		} else if (hex.length === 6 || hex.length === 8) {
			hex = hex.slice(0, 6);
		} else {
			return undefined;
		}

		const numeric = Number.parseInt(hex, 16);
		if (Number.isNaN(numeric)) {
			return undefined;
		}

		return {
			r: (numeric >> 16) & 0xff,
			g: (numeric >> 8) & 0xff,
			b: numeric & 0xff,
		};
	}
}

interface PanelMessageBase {
	type: string;
}

type PanelMessage =
	| (PanelMessageBase & { type: 'requestData' })
	| (PanelMessageBase & { type: 'addRule' })
	| (PanelMessageBase & { type: 'createRule'; payload: CreateRulePayload })
	| (PanelMessageBase & { type: 'removeRule'; ruleId: string })
	| (PanelMessageBase & { type: 'updatePattern'; ruleId: string; pattern: string })
	| (PanelMessageBase & { type: 'updateColor'; ruleId: string; color: string })
	| (PanelMessageBase & {
			type: 'toggleOption';
			ruleId: string;
			option: RuleOptionKey;
	  })
	| (PanelMessageBase & {
			type: 'changeScope';
			ruleId: string;
			scope: RuleScope;
			documentUri: string;
	  })
	| (PanelMessageBase & {
			type: 'navigate';
			ruleId: string;
			documentUri: string;
			direction: NavigationDirection;
	  });

class HighlightPanelProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private disposables: vscode.Disposable[] = [];

	constructor(
		private readonly controller: HighlightController,
		private readonly extensionUri: vscode.Uri
	) {}

	resolveWebviewView(webviewView: vscode.WebviewView) {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri],
		};

		webviewView.webview.html = this.getHtml(webviewView.webview);

		const update = () => this.postRules();
		this.disposables.push(
			this.controller.onDidChangeRules(update),
			vscode.window.onDidChangeActiveTextEditor(update)
		);

		webviewView.onDidDispose(() => {
			this.disposables.forEach((disposable) => disposable.dispose());
			this.disposables = [];
		});

		webviewView.webview.onDidReceiveMessage((message: PanelMessage) => {
			switch (message.type) {
				case 'requestData':
					this.postRules();
					break;
				case 'addRule':
					void this.controller.addHighlightRule();
					break;
				case 'createRule':
					void this.controller.createRuleFromPayload(message.payload);
					break;
				case 'removeRule':
					this.controller.deleteRule(message.ruleId);
					break;
				case 'updatePattern':
					this.controller.updateRulePattern(message.ruleId, message.pattern);
					break;
				case 'updateColor':
					this.controller.updateRuleColor(message.ruleId, message.color);
					break;
				case 'toggleOption':
					this.controller.toggleRuleOption(message.ruleId, message.option);
					break;
				case 'changeScope':
					void this.controller.changeRuleScope(message.ruleId, message.scope, message.documentUri);
					break;
				case 'navigate':
					void this.controller.navigateToMatch(message.documentUri, message.ruleId, message.direction);
					break;
				default:
					break;
			}
		});

		this.postRules();
	}

	private postRules() {
		if (!this.view) {
			return;
		}

		const editor = vscode.window.activeTextEditor;
		const uri = editor?.document.uri.toString() ?? null;
		const rules = this.controller.getRuleSnapshots(uri);
		const scopeData = this.controller.getScopeSelectionData(editor?.document ?? null);

		this.view.webview.postMessage({
			type: 'rulesUpdate',
			rules,
			activeUri: uri,
			scopeOptions: scopeData.options,
			defaultScope: scopeData.defaultScope,
		});
	}

	private getHtml(webview: vscode.Webview): string {
		const nonce = HighlightPanelProvider.createNonce();
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>Smart Highlights</title>
	<style>
		body {
			font-family: var(--vscode-font-family);
			color: var(--vscode-foreground);
			background: var(--vscode-sideBar-background);
			margin: 0;
			padding: 0;
		}

		.panel {
			display: flex;
			flex-direction: column;
			height: 100vh;
		}

		.panel-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 8px;
			border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
		}

		.header-title {
			font-weight: 600;
			font-size: 12px;
			letter-spacing: 0.05em;
		}

		button {
			border: none;
			cursor: pointer;
			background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
			color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
			border-radius: 4px;
			padding: 2px 6px;
			font-size: 12px;
		}

		button:hover {
			background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
		}

		button:disabled {
			opacity: 0.4;
			cursor: not-allowed;
		}

		.new-rule {
			display: flex;
			flex-direction: column;
			gap: 6px;
			padding: 8px;
			border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-editorWidget-border));
		}

		.new-rule input[type="text"] {
			width: 100%;
			padding: 4px 6px;
			border-radius: 3px;
			border: 1px solid var(--vscode-input-border, var(--vscode-focusBorder));
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
		}

		.form-options-row {
			display: flex;
			align-items: center;
			gap: 8px;
			flex-wrap: wrap;
		}

		.form-options-row .options-toggle-row {
			flex: 1;
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 8px;
		}

		.form-options-row .color-row {
			flex-shrink: 0;
		}

		.options-toggle-row .option-buttons,
		.rule-options {
			display: flex;
			gap: 6px;
			flex-wrap: wrap;
		}

		.option-toggle {
			width: 32px;
			height: 24px;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			padding: 0;
			border-radius: 4px;
			border: 1px solid var(--vscode-input-border, var(--vscode-focusBorder));
			background: var(--vscode-sideBarSectionHeader-background, transparent);
			color: var(--vscode-foreground);
			font-size: 12px;
		}

		.option-toggle.active {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border-color: var(--vscode-button-background);
		}

		.scope-toggle-group {
			display: inline-flex;
			gap: 4px;
			align-items: center;
		}

		.scope-toggle-button {
			min-width: 72px;
			height: 24px;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			padding: 0 6px;
			border-radius: 4px;
			border: 1px solid var(--vscode-input-border, var(--vscode-focusBorder));
			background: var(--vscode-sideBarSectionHeader-background, transparent);
			color: var(--vscode-foreground);
			font-size: 11px;
			white-space: nowrap;
		}

		.scope-toggle-button.active {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border-color: var(--vscode-button-background);
		}

		.scope-toggle-button:disabled {
			opacity: 0.5;
		}

		.filter-row {
			display: flex;
		}

		.filter-row input {
			width: 100%;
		}

		.color-row {
			display: flex;
			align-items: center;
			gap: 8px;
		}

		.color-row input[type="color"] {
			width: 36px;
			height: 24px;
			padding: 0;
			border: none;
			background: transparent;
		}

		.color-text-hidden {
			position: absolute;
			width: 1px;
			height: 1px;
			padding: 0;
			margin: -1px;
			border: 0;
			clip: rect(0 0 0 0);
			overflow: hidden;
		}

		.rule-list {
			flex: 1;
			overflow-y: auto;
			padding: 8px;
			display: flex;
			flex-direction: column;
			gap: 6px;
		}

		.rule-row {
			display: flex;
			flex-direction: column;
			gap: 6px;
			padding: 6px;
			border: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-editorWidget-border));
			border-radius: 4px;
			background: var(--vscode-sideBarSectionHeader-background, transparent);
		}

		.rule-main {
			display: flex;
			flex-direction: column;
			gap: 6px;
		}

		.rule-primary-row {
			display: grid;
			grid-template-columns: 1fr auto auto;
			align-items: center;
			gap: 6px;
			width: 100%;
		}

		.nav-buttons {
			display: flex;
			gap: 4px;
		}

		.pattern-button {
			text-align: left;
			padding: 4px 6px;
			border-radius: 3px;
			border: 1px solid transparent;
			font-size: 12px;
			flex: 1;
			min-width: 0;
		}

		.pattern-button:hover {
			border-color: var(--vscode-focusBorder);
		}

		.pattern-input {
			width: 100%;
			font-size: 12px;
			padding: 2px 4px;
			border-radius: 3px;
			border: 1px solid var(--vscode-input-border, var(--vscode-focusBorder));
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
		}

		.rule-options {
			margin-top: 0;
		}

		.color-button {
			display: flex;
			align-items: center;
			justify-content: center;
			padding: 4px;
			border-radius: 3px;
		}

		.rule-secondary-row {
			display: grid;
			grid-template-columns: 1fr auto auto;
			gap: 6px;
			align-items: center;
			width: 100%;
		}

		.match-count {
			min-width: 56px;
			text-align: center;
			font-size: 11px;
			padding: 2px 10px;
			border-radius: 999px;
			border: 1px solid var(--vscode-input-border, var(--vscode-focusBorder));
			color: var(--vscode-descriptionForeground);
		}

		.match-count.has-matches {
			color: var(--vscode-foreground);
			border-color: var(--vscode-focusBorder, var(--vscode-input-border));
		}

		.match-count.empty {
			opacity: 0.6;
		}

		.color-swatch {
			width: 18px;
			height: 14px;
			border-radius: 3px;
			border: 1px solid var(--vscode-editorWidget-border);
		}

		.empty-state {
			padding: 16px;
			text-align: center;
			color: var(--vscode-descriptionForeground);
		}

		.color-overlay {
			position: fixed;
			inset: 0;
			background: rgba(0, 0, 0, 0.35);
			display: flex;
			align-items: center;
			justify-content: center;
			z-index: 10;
		}

		.color-overlay.hidden {
			display: none;
		}

		.color-overlay-content {
			background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
			color: var(--vscode-editorWidget-foreground, var(--vscode-foreground));
			border: 1px solid var(--vscode-editorWidget-border, var(--vscode-sideBarSectionHeader-border));
			border-radius: 6px;
			padding: 12px;
			min-width: 260px;
			box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
			display: flex;
			flex-direction: column;
			gap: 8px;
		}

		.color-overlay-body {
			display: flex;
			flex-direction: column;
			gap: 8px;
		}

		.color-overlay-body input[type="color"] {
			width: 60px;
			height: 34px;
			border: none;
			padding: 0;
			align-self: flex-start;
			background: transparent;
		}

		.color-overlay-body input[type="text"] {
			width: 100%;
			padding: 4px 6px;
			border-radius: 3px;
			border: 1px solid var(--vscode-input-border, var(--vscode-focusBorder));
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
		}

		.color-overlay-actions {
			display: flex;
			justify-content: flex-end;
			gap: 6px;
		}

		.color-overlay-actions .primary {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
		}
	</style>
</head>
<body>
	<div class="panel">
		<div class="panel-header">
			<span class="header-title">Highlights</span>
		</div>
		<div id="newRuleForm" class="new-rule">
			<input id="patternInput" type="text" placeholder="Highlight text or /regex/">
		<div class="form-options-row">
			<div class="options-toggle-row" id="newRuleOptions">
				<div class="option-buttons">
					<button type="button" class="option-toggle" data-option="matchCase" title="Match Case (Aa)">Aa</button>
					<button type="button" class="option-toggle" data-option="matchWholeWord" title="Match Whole Word (W)">W</button>
					<button type="button" class="option-toggle" data-option="useRegex" title="Use Regular Expression (.*)">.*</button>
					<button type="button" class="option-toggle scope-toggle-button" id="scopeToggleButton" title="Open a file to choose scope">Scope</button>
				</div>
			</div>
			<div class="color-row">
				<input type="color" id="colorPicker" value="#00c400" aria-label="Highlight color">
				<input type="text" id="colorText" class="color-text-hidden" value="#00c4005d" tabindex="-1" aria-hidden="true">
			</div>
		</div>
		<div class="filter-row">
			<input type="text" id="fileFilterInput" placeholder="Extensions (e.g. *.txt|*.json|*.*)">
		</div>
	</div>
		<div id="ruleList" class="rule-list"></div>
		<div id="colorOverlay" class="color-overlay hidden" role="dialog" aria-modal="true">
			<div class="color-overlay-content">
				<div class="color-overlay-body">
					<input type="color" id="inlineColorPicker" value="#00c4ff">
					<input type="text" id="inlineColorText" placeholder="CSS color (e.g. #00c4ff80)">
				</div>
				<div class="color-overlay-actions">
					<button type="button" id="colorOverlayCancel">Cancel</button>
					<button type="button" id="colorOverlayApply" class="primary">Apply</button>
				</div>
			</div>
		</div>
	</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const state = {
			rules: [],
			activeUri: null,
			formOptions: { matchCase: false, matchWholeWord: false, useRegex: false },
			suggestedColor: null,
			lastAppliedSuggestion: null,
			scopeOptions: [],
			selectedScope: null,
			fileFilter: '*.*',
		};
		const listEl = document.getElementById('ruleList');
		const patternInput = document.getElementById('patternInput');
		const colorPicker = document.getElementById('colorPicker');
		const colorText = document.getElementById('colorText');
		const optionButtons = Array.from(document.querySelectorAll('#newRuleOptions .option-toggle')).filter(
			(button) => button instanceof HTMLElement && button.dataset.option
		);
		const scopeButton = document.getElementById('scopeToggleButton');
		const fileFilterInput = document.getElementById('fileFilterInput');
		const colorParserCanvas = document.createElement('canvas');
		const colorParser = colorParserCanvas.getContext('2d');
		const colorOverlay = document.getElementById('colorOverlay');
		const inlineColorPicker = document.getElementById('inlineColorPicker');
		const inlineColorText = document.getElementById('inlineColorText');
		const colorOverlayApply = document.getElementById('colorOverlayApply');
		const colorOverlayCancel = document.getElementById('colorOverlayCancel');
		let colorEditorState = null;

		applyOptionButtonState();

		let formEnabled = false;

		const OPTION_META = [
			{ key: 'matchCase', label: 'Aa', title: 'Match Case' },
			{ key: 'matchWholeWord', label: 'W', title: 'Match Whole Word' },
			{ key: 'useRegex', label: '.*', title: 'Use Regular Expression' },
		];
		const SCOPE_META = [
			{ scope: 'document', label: 'F', title: 'Current file only (F)' },
			{ scope: 'folder', label: 'D', title: 'Current folder only (D)' },
			{ scope: 'folderRecursive', label: 'D+', title: 'Folder and subfolders (D+)' },
		];
		const BASE_COLORS = ['#00c4ff', '#ffd400', '#8ac926', '#ff595e', '#6a4c93', '#1982c4', '#ff924c', '#fb5607'];
		const DEFAULT_ALPHA = '80';

		setFormEnabled(false);
		updateScopeButtonState();
		if (fileFilterInput instanceof HTMLInputElement) {
			fileFilterInput.value = state.fileFilter;
			fileFilterInput.addEventListener('input', () => {
				state.fileFilter = fileFilterInput.value;
			});
		}

		if (scopeButton instanceof HTMLButtonElement) {
			scopeButton.addEventListener('click', () => {
				if (scopeButton.disabled) {
					return;
				}
				cycleScope();
			});
		}

		function applyOptionButtonState() {
			optionButtons.forEach((button) => {
				const key = button.dataset.option;
				if (!key) {
					return;
				}
				button.classList.toggle('active', !!state.formOptions[key]);
			});
		}

		function getAvailableScopes() {
			const scopes = state.scopeOptions.map((option) => option.scope);
			return scopes.filter((scope, index) => scopes.indexOf(scope) === index);
		}

		function getOrderedScopes() {
			const available = getAvailableScopes();
			return SCOPE_META.filter((meta) => available.includes(meta.scope));
		}

		function getNextScopeValue(currentScope) {
			const ordered = getOrderedScopes();
			if (!ordered.length) {
				return null;
			}
			if (!currentScope) {
				return ordered[0].scope;
			}
			const currentIndex = ordered.findIndex((meta) => meta.scope === currentScope);
			if (currentIndex === -1) {
				return ordered[0].scope;
			}
			return ordered[(currentIndex + 1) % ordered.length].scope;
		}

		function getScopeMeta(scope) {
			return SCOPE_META.find((meta) => meta.scope === scope) ?? null;
		}

		function setScopeButtonAppearance(button, scope) {
			if (!(button instanceof HTMLButtonElement)) {
				return;
			}
			const meta = scope ? getScopeMeta(scope) : null;
			if (!meta) {
				button.textContent = 'Scope';
				button.title = 'Open a file to choose scope';
				return;
			}
			button.textContent = meta.label;
			button.title = meta.title;
		}

		function cycleScope() {
			const nextScope = getNextScopeValue(state.selectedScope);
			if (!nextScope) {
				return;
			}
			state.selectedScope = nextScope;
			updateScopeButtonState();
		}

		function updateScopeButtonState() {
			if (!(scopeButton instanceof HTMLButtonElement)) {
				return;
			}
			const available = getAvailableScopes();
			if (!available.length) {
				state.selectedScope = null;
				scopeButton.disabled = true;
				scopeButton.textContent = 'Scope';
				scopeButton.title = 'Open a file to choose scope';
				scopeButton.classList.remove('active');
				return;
			}
			if (!state.selectedScope || !available.includes(state.selectedScope)) {
				state.selectedScope = available[0];
			}
			scopeButton.disabled = !formEnabled;
			setScopeButtonAppearance(scopeButton, state.selectedScope);
			scopeButton.classList.toggle('active', formEnabled);
		}

		function updateScopeOptions(options, defaultScope) {
			state.scopeOptions = Array.isArray(options) ? options : [];
			if (!state.scopeOptions.some((option) => option.scope === state.selectedScope)) {
				if (
					defaultScope &&
					state.scopeOptions.some((option) => option.scope === defaultScope)
				) {
					state.selectedScope = defaultScope;
				} else {
					state.selectedScope = state.scopeOptions[0]?.scope ?? null;
				}
			}
			updateScopeButtonState();
		}

		function cycleRuleScope(row) {
			if (!row) {
				return;
			}
			const documentUri = row.dataset.uri || state.activeUri;
			if (!documentUri) {
				return;
			}
			const currentScope = row.dataset.scope || null;
			const nextScope = getNextScopeValue(currentScope);
			if (!nextScope) {
				return;
			}
			vscode.postMessage({
				type: 'changeScope',
				ruleId: row.dataset.ruleId,
				scope: nextScope,
				documentUri,
			});
		}

		function render() {
			if (!listEl) {
				return;
			}

			listEl.innerHTML = '';

			if (!state.activeUri) {
				listEl.innerHTML = '<div class="empty-state">Open a text editor to manage highlights.</div>';
				setFormEnabled(false);
				resetFormFields();
				return;
			}

				if (state.rules.length === 0) {
					listEl.innerHTML = '<div class="empty-state">No highlight rules yet. Use the form above to add one.</div>';
					return;
				}

			state.rules.forEach((rule) => {
				const row = document.createElement('div');
				row.className = 'rule-row';
				row.dataset.ruleId = rule.id;
				row.dataset.uri = rule.documentUri;
				row.dataset.color = rule.color;
				row.dataset.scope = rule.scope;
				row.dataset.targetUri = rule.targetUri;

				const main = document.createElement('div');
				main.className = 'rule-main';
				const primaryRow = document.createElement('div');
				primaryRow.className = 'rule-primary-row';

				const patternButton = document.createElement('button');
				patternButton.type = 'button';
				patternButton.className = 'pattern-button';
				patternButton.textContent = rule.pattern;
				patternButton.title = 'Click to edit the search text';
				patternButton.dataset.role = 'pattern';
				setPatternAppearance(patternButton, rule.color);
				primaryRow.appendChild(patternButton);

				const nav = document.createElement('div');
				nav.className = 'nav-buttons';
				const prev = document.createElement('button');
				prev.textContent = '▲';
				prev.title = 'Previous match';
				prev.className = 'nav-prev';
				const next = document.createElement('button');
				next.textContent = '▼';
				next.title = 'Next match';
				next.className = 'nav-next';
				nav.appendChild(prev);
				nav.appendChild(next);
				primaryRow.appendChild(nav);

				const removeButton = document.createElement('button');
				removeButton.textContent = '✕';
				removeButton.title = 'Remove highlight';
				removeButton.className = 'remove-rule';
				primaryRow.appendChild(removeButton);

				const colorButton = document.createElement('button');
				colorButton.className = 'color-button';
				colorButton.title = 'Change highlight color';
				colorButton.dataset.role = 'color';
				const swatch = document.createElement('span');
				swatch.className = 'color-swatch';
				swatch.style.background = rule.color;
				colorButton.appendChild(swatch);

				const secondRow = document.createElement('div');
				secondRow.className = 'rule-secondary-row';
				const optionRow = document.createElement('div');
				optionRow.className = 'rule-options';
				OPTION_META.forEach((meta) => {
					const button = document.createElement('button');
					button.type = 'button';
					button.className = 'option-toggle';
					if (rule[meta.key]) {
						button.classList.add('active');
					}
					button.dataset.option = meta.key;
					button.textContent = meta.label;
					button.title = meta.title;
					optionRow.appendChild(button);
				});
				const scopeToggleButton = document.createElement('button');
				scopeToggleButton.type = 'button';
				scopeToggleButton.className = 'option-toggle scope-toggle-button';
				scopeToggleButton.dataset.role = 'scope';
				setScopeButtonAppearance(scopeToggleButton, rule.scope);
				optionRow.appendChild(scopeToggleButton);
				secondRow.appendChild(optionRow);
				secondRow.appendChild(colorButton);

				const matchBadge = document.createElement('div');
				matchBadge.className = 'match-count';
				updateMatchBadge(
					matchBadge,
					rule.matchCount,
					rule.currentMatchIndex,
					rule.documentMatchCount,
					rule.documentMatchIndex
				);
				secondRow.appendChild(matchBadge);

				main.appendChild(primaryRow);
				main.appendChild(secondRow);

				row.appendChild(main);
				listEl.appendChild(row);
			});
		}

		function setPatternAppearance(element, color) {
			if (!(element instanceof HTMLElement)) {
				return;
			}
			element.style.background = color;
			element.style.borderColor = color;
			const contrast = getContrastColor(color);
			element.style.color = contrast || '';
		}

		function updateMatchBadge(element, total, currentIndex, documentCount, documentIndex) {
			if (!(element instanceof HTMLElement)) {
				return;
			}
			const totalCount = Number.isFinite(total) ? Number(total) : 0;
			const globalIndex =
				typeof currentIndex === 'number' && Number.isFinite(currentIndex) ? Math.trunc(currentIndex) : null;
			const localCount =
				typeof documentCount === 'number' && Number.isFinite(documentCount) ? Math.trunc(documentCount) : 0;
			const localIndex =
				typeof documentIndex === 'number' && Number.isFinite(documentIndex) ? Math.trunc(documentIndex) : null;
			const showFraction = globalIndex !== null && totalCount > 0;

			if (showFraction) {
				element.textContent = globalIndex + ' / ' + totalCount;
			} else {
				element.textContent = totalCount.toString();
			}

			let title = totalCount === 1 ? '1 hit across scope' : totalCount + ' hits across scope';
			if (localCount > 0) {
				title += localCount === 1 ? ' - 1 hit in this file' : ' - ' + localCount + ' hits in this file';
				if (localIndex && localIndex <= localCount) {
					title += ' (match ' + localIndex + ' of ' + localCount + ')';
				}
			} else {
				title += ' - none in this file';
			}
			element.title = title;

			element.classList.toggle('has-matches', totalCount > 0);
			element.classList.toggle('empty', totalCount === 0);
		}

		function getContrastColor(color) {
			const parsed = parseColor(color);
			if (!parsed) {
				return '';
			}
			const luminance = (0.299 * parsed.r + 0.587 * parsed.g + 0.114 * parsed.b) / 255;
			return luminance > 0.6 ? '#1f1f1f' : '#ffffff';
		}

		function parseColor(value) {
			if (!colorParser) {
				return null;
			}
			try {
				colorParser.fillStyle = '#000000';
				colorParser.fillStyle = value;
				const computed = colorParser.fillStyle;
				if (computed.startsWith('#')) {
					let hex = computed.slice(1);
					if (hex.length === 3) {
						hex = hex.split('').map((c) => c + c).join('');
					}
					const num = parseInt(hex.slice(0, 6), 16);
					return {
						r: (num >> 16) & 255,
						g: (num >> 8) & 255,
						b: num & 255,
					};
				}
				const match = computed.match(/rgba?\(([^)]+)\)/);
				if (match) {
					const parts = match[1].split(',').map((part) => part.trim());
					return {
						r: Number(parts[0]),
						g: Number(parts[1]),
						b: Number(parts[2]),
					};
				}
			} catch {
				return null;
			}
			return null;
		}

		function rgbToHex(rgb) {
			const toHex = (component) => Math.max(0, Math.min(255, component)).toString(16).padStart(2, '0');
			return '#' + toHex(rgb.r) + toHex(rgb.g) + toHex(rgb.b);
		}

		function pickerValueFromColor(color) {
			const parsed = parseColor(color);
			if (!parsed) {
				return state.suggestedColor?.picker || BASE_COLORS[0];
			}
			return rgbToHex(parsed);
		}

		function extractAlphaSuffix(color) {
			const trimmed = (color || '').trim();
			if (!trimmed.startsWith('#')) {
				return null;
			}
			if (trimmed.length === 9) {
				return trimmed.slice(7);
			}
			if (trimmed.length === 5) {
				const char = trimmed.slice(4);
				return char + char;
			}
			return null;
		}

		function asElement(target) {
			if (target instanceof HTMLElement) {
				return target;
			}
			if (target instanceof Element) {
				return target;
			}
			if (target instanceof Node && target.parentElement) {
				return target.parentElement;
			}
			return null;
		}

		function findRowTarget(target) {
			const element = asElement(target);
			return element?.closest('.rule-row') ?? null;
		}

		function startPatternEdit(row) {
			if (!row || row.dataset.editing === 'true') {
				return;
			}
			row.dataset.editing = 'true';
			const display = row.querySelector('.pattern-button');
			if (!display) {
				row.dataset.editing = 'false';
				return;
			}
			const currentValue = display.textContent || '';
			const input = document.createElement('input');
			input.type = 'text';
			input.value = currentValue;
			input.className = 'pattern-input';
			const container = display.parentElement ?? row;
			container.insertBefore(input, display);
			(display).style.display = 'none';
			input.focus();
			input.select();

			let completed = false;
			const finish = (commit) => {
				if (completed) {
					return;
				}
				completed = true;
				row.dataset.editing = 'false';
				(display).style.display = '';
				input.remove();
				if (!commit) {
					return;
				}
				const nextValue = input.value.trim();
				if (nextValue && nextValue !== currentValue) {
					vscode.postMessage({
						type: 'updatePattern',
						ruleId: row.dataset.ruleId,
						pattern: nextValue,
					});
					(display).textContent = nextValue;
				} else {
					(display).textContent = currentValue;
				}
			};

			input.addEventListener('keydown', (event) => {
				if (event.key === 'Enter') {
					event.preventDefault();
					finish(true);
				} else if (event.key === 'Escape') {
					event.preventDefault();
					finish(false);
				}
			});

			input.addEventListener('blur', () => finish(false));
		}

		function showColorOverlay(row) {
			if (!(colorOverlay instanceof HTMLElement)) {
				return;
			}
			if (!(inlineColorPicker instanceof HTMLInputElement) || !(inlineColorText instanceof HTMLInputElement)) {
				return;
			}
			const ruleId = row.dataset.ruleId;
			if (!ruleId) {
				return;
			}

			closeColorOverlay(false);

			const currentColor = row.dataset.color || '';
			const pickerValue = pickerValueFromColor(currentColor);
			const alphaSuffix = extractAlphaSuffix(currentColor) ?? DEFAULT_ALPHA;

			inlineColorPicker.value = pickerValue;
			inlineColorText.value = currentColor || pickerValue + alphaSuffix;
			if (typeof inlineColorText.setSelectionRange === 'function') {
				inlineColorText.setSelectionRange(0, inlineColorText.value.length);
			}

			colorEditorState = { ruleId, row, alphaSuffix };
			colorOverlay.classList.remove('hidden');
			(inlineColorText.value ? inlineColorText : inlineColorPicker).focus();
		}

		function closeColorOverlay(commit) {
			if (!(colorOverlay instanceof HTMLElement)) {
				return;
			}
			if (!colorEditorState) {
				colorOverlay.classList.add('hidden');
				return;
			}
			const { ruleId, row, alphaSuffix } = colorEditorState;
			colorEditorState = null;

			let nextColor = '';
			if (commit) {
				if (inlineColorText instanceof HTMLInputElement) {
					nextColor = inlineColorText.value.trim();
				}
				if (!nextColor && inlineColorPicker instanceof HTMLInputElement) {
					nextColor = inlineColorPicker.value + (alphaSuffix || DEFAULT_ALPHA);
				}
			}

			if (inlineColorText instanceof HTMLInputElement) {
				inlineColorText.value = '';
			}

			colorOverlay.classList.add('hidden');

			if (!commit || !nextColor) {
				return;
			}

			vscode.postMessage({ type: 'updateColor', ruleId, color: nextColor });
			row.dataset.color = nextColor;
			const patternButton = row.querySelector('.pattern-button');
			if (patternButton instanceof HTMLElement) {
				setPatternAppearance(patternButton, nextColor);
			}
			const swatchEl = row.querySelector('.color-swatch');
			if (swatchEl instanceof HTMLElement) {
				swatchEl.style.background = nextColor;
			}
		}

		listEl?.addEventListener('click', (event) => {
			const target = asElement(event.target);
			const row = findRowTarget(target);
			if (!row) {
				return;
			}

			const ruleId = row.dataset.ruleId;
			const uri = row.dataset.uri;
			if (!ruleId || !uri) {
				return;
			}

			if (target?.closest('.nav-prev')) {
				vscode.postMessage({ type: 'navigate', direction: 'previous', ruleId, documentUri: uri });
				return;
			}

			if (target?.closest('.nav-next')) {
				vscode.postMessage({ type: 'navigate', direction: 'next', ruleId, documentUri: uri });
				return;
			}

			if (target?.closest('.remove-rule')) {
				vscode.postMessage({ type: 'removeRule', ruleId });
				return;
			}

			if (target?.closest('.color-button')) {
				showColorOverlay(row);
				return;
			}

			const optionButton = target?.closest('.option-toggle');
			if (optionButton) {
				if (optionButton.dataset.role === 'scope') {
					cycleRuleScope(row);
				} else {
					const optionKey = optionButton.dataset.option;
					if (optionKey) {
						vscode.postMessage({ type: 'toggleOption', ruleId, option: optionKey });
					}
				}
				return;
			}

			if (target?.closest('.pattern-button')) {
				startPatternEdit(row);
			}
		});

		colorOverlayApply?.addEventListener('click', () => closeColorOverlay(true));
		colorOverlayCancel?.addEventListener('click', () => closeColorOverlay(false));

		colorOverlay?.addEventListener('click', (event) => {
			if (event.target === colorOverlay) {
				closeColorOverlay(false);
			}
		});

		colorOverlay?.addEventListener('keydown', (event) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				closeColorOverlay(false);
			}
		});

		inlineColorPicker?.addEventListener('input', () => {
			if (
				!(inlineColorPicker instanceof HTMLInputElement) ||
				!(inlineColorText instanceof HTMLInputElement)
			) {
				return;
			}
			const alpha = colorEditorState?.alphaSuffix ?? DEFAULT_ALPHA;
			inlineColorText.value = inlineColorPicker.value + alpha;
		});

		inlineColorText?.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && !event.isComposing) {
				event.preventDefault();
				closeColorOverlay(true);
			} else if (event.key === 'Escape') {
				event.preventDefault();
				closeColorOverlay(false);
			}
		});

		function setFormEnabled(enabled) {
			formEnabled = enabled;
			if (patternInput instanceof HTMLInputElement) {
				patternInput.disabled = !enabled;
				patternInput.placeholder = enabled ? 'Highlight text or /regex/' : 'Open a file to add highlights.';
			}
			optionButtons.forEach((button) => {
				button.disabled = !enabled;
			});
			if (colorPicker instanceof HTMLInputElement) {
				colorPicker.disabled = !enabled;
			}
			if (colorText instanceof HTMLInputElement) {
				colorText.disabled = !enabled;
			}
			if (fileFilterInput instanceof HTMLInputElement) {
				fileFilterInput.disabled = !enabled;
			}
			updateScopeButtonState();
			if (!enabled) {
				state.suggestedColor = null;
				state.lastAppliedSuggestion = null;
				return;
			}
			updateSuggestedColor([], true);
			patternInput?.focus();
		}

		function resetFormFields() {
			if (patternInput instanceof HTMLInputElement) {
				patternInput.value = '';
			}
		}

		function normalizeColorForComparison(color) {
			if (!color) {
				return '';
			}
			let trimmed = color.trim().toLowerCase();
			if (!trimmed.startsWith('#')) {
				return trimmed;
			}
				if (trimmed.length === 4) {
					trimmed =
						'#' +
						trimmed[1] +
						trimmed[1] +
						trimmed[2] +
						trimmed[2] +
						trimmed[3] +
						trimmed[3];
			}
			if (trimmed.length === 9) {
				return trimmed.slice(0, 7);
			}
			return trimmed.slice(0, 7);
		}

		function hslToHex(h, s, l) {
			s /= 100;
			l /= 100;
			const k = (n) => (n + h / 30) % 12;
			const a = s * Math.min(l, 1 - l);
			const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
			const toHex = (value) => Math.round(value * 255).toString(16).padStart(2, '0');
			return '#' + toHex(f(0)) + toHex(f(8)) + toHex(f(4));
		}

		function pickColor(used) {
			for (const hex of BASE_COLORS) {
				if (!used.has(hex)) {
					return { picker: hex, text: hex + DEFAULT_ALPHA };
				}
			}
			let index = used.size;
			while (index < used.size + 1000) {
				const hue = (index * 137.508) % 360;
				const hex = hslToHex(hue, 70, 55);
				if (!used.has(hex)) {
					return { picker: hex, text: hex + DEFAULT_ALPHA };
				}
				index += 1;
			}
			return { picker: '#00c4ff', text: '#00c4ff' + DEFAULT_ALPHA };
		}

		function updateSuggestedColor(extraColors = [], force = false) {
			if (!state.activeUri) {
				state.suggestedColor = null;
				state.lastAppliedSuggestion = null;
				return;
			}
			const used = new Set(state.rules.map((rule) => normalizeColorForComparison(rule.color)));
			extraColors.forEach((color) => used.add(normalizeColorForComparison(color)));
			state.suggestedColor = pickColor(used);
			applySuggestedColor(force || !colorText?.value.trim());
		}

		function applySuggestedColor(force) {
			if (!state.suggestedColor || !state.activeUri) {
				return;
			}
			if (!(colorPicker instanceof HTMLInputElement) || !(colorText instanceof HTMLInputElement)) {
				return;
			}
			const current = colorText.value.trim().toLowerCase();
			const shouldApply = force || !current || current === state.lastAppliedSuggestion;
			if (!shouldApply) {
				return;
			}
			colorPicker.value = state.suggestedColor.picker;
			colorText.value = state.suggestedColor.text;
			state.lastAppliedSuggestion = state.suggestedColor.text.toLowerCase();
		}

		function submitForm() {
			if (!patternInput || !colorText || !state.activeUri) {
				return;
			}
			const pattern = patternInput.value.trim();
			const colorValue = (colorText.value || colorPicker?.value || '').trim();
			const filterValue =
				fileFilterInput instanceof HTMLInputElement ? fileFilterInput.value.trim() : '';
			if (!pattern || !colorValue) {
				return;
			}

			const options = { ...state.formOptions };
			vscode.postMessage({
				type: 'createRule',
				payload: {
					pattern,
					color: colorValue,
					matchCase: options.matchCase,
					matchWholeWord: options.matchWholeWord,
					useRegex: options.useRegex,
					scope: state.selectedScope || state.scopeOptions[0]?.scope || 'document',
					documentUri: state.activeUri,
					fileFilter: filterValue || undefined,
				},
			});
			state.lastAppliedSuggestion = colorValue.toLowerCase();
			resetFormFields();
			updateSuggestedColor([colorValue], true);
			patternInput.focus();
		}

		patternInput?.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && !event.isComposing) {
				event.preventDefault();
				submitForm();
			}
		});

		optionButtons.forEach((button) => {
			button.addEventListener('click', () => {
				if (button.disabled) {
					return;
				}
				button.classList.toggle('active');
				const key = button.dataset.option;
				if (key) {
					state.formOptions[key] = button.classList.contains('active');
				}
			});
		});

		colorPicker?.addEventListener('input', () => {
			if (colorText instanceof HTMLInputElement && colorPicker instanceof HTMLInputElement) {
				colorText.value = colorPicker.value + DEFAULT_ALPHA;
				state.lastAppliedSuggestion = null;
			}
		});

		colorText?.addEventListener('input', () => {
			if (colorText instanceof HTMLInputElement && colorPicker instanceof HTMLInputElement) {
				const value = colorText.value.trim();
				const match = value.match(/^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/);
				if (match) {
					colorPicker.value = '#' + match[1];
				}
				state.lastAppliedSuggestion = null;
			}
		});

			window.addEventListener('message', (event) => {
				const message = event.data;
				if (message.type === 'rulesUpdate') {
					state.rules = Array.isArray(message.rules) ? message.rules : [];
					state.activeUri = message.activeUri || null;
					updateScopeOptions(message.scopeOptions || [], message.defaultScope || null);
					if (!state.activeUri) {
						setFormEnabled(false);
						resetFormFields();
					} else {
						setFormEnabled(true);
					}
					updateSuggestedColor();
					render();
				}
			});

			updateSuggestedColor([], true);
			vscode.postMessage({ type: 'requestData' });
	</script>
</body>
</html>`;
	}

	private static createNonce(): string {
		return `${Math.random().toString(36).substring(2, 15)}`;
	}
}

export function activate(context: vscode.ExtensionContext) {
	const controller = new HighlightController(context);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			'conditional-coloring.panel',
			new HighlightPanelProvider(controller, context.extensionUri)
		)
	);
}

export function deactivate() {}


