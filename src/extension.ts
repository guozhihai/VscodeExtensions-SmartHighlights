import * as vscode from 'vscode';

type NavigationDirection = 'next' | 'previous';
type RuleOptionKey = 'matchCase' | 'matchWholeWord' | 'useRegex';

interface CreateRulePayload {
	documentUri: string;
	pattern: string;
	color: string;
	matchCase: boolean;
	matchWholeWord: boolean;
	useRegex: boolean;
}

interface HighlightRule {
	id: string;
	pattern: string;
	color: string;
	matchCase: boolean;
	matchWholeWord: boolean;
	useRegex: boolean;
	decoration: vscode.TextEditorDecorationType;
	documentUri: string;
	matchCount: number;
}

interface PanelRule extends Omit<HighlightRule, 'decoration'> {
	description: string;
}

type RuleMap = Map<string, HighlightRule[]>;

class HighlightController {
	private readonly rulesByDocument: RuleMap = new Map();
	private readonly onDidChangeRulesEmitter = new vscode.EventEmitter<void>();

	public readonly onDidChangeRules = this.onDidChangeRulesEmitter.event;

	constructor(context: vscode.ExtensionContext) {
		context.subscriptions.push(
			this.onDidChangeRulesEmitter,
			vscode.workspace.onDidChangeTextDocument((event) => {
				const uri = event.document.uri.toString();
				if (this.rulesByDocument.has(uri)) {
					this.updateDecorationsForUri(uri);
					this.notifyRulesChanged();
				}
			}),
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				if (editor) {
					this.applyRules(editor);
				}
				this.notifyRulesChanged();
			}),
			vscode.workspace.onDidCloseTextDocument((document) => {
				const uri = document.uri.toString();
				const rules = this.rulesByDocument.get(uri);
				if (!rules) {
					return;
				}

				for (const rule of rules) {
					this.clearRuleDecorations(uri, rule);
				}
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

		const success = this.createRuleFromOptions(editor, {
			pattern,
			color,
			matchCase: options?.some((option) => option.option === 'matchCase') ?? false,
			matchWholeWord: options?.some((option) => option.option === 'matchWholeWord') ?? false,
			useRegex: options?.some((option) => option.option === 'useRegex') ?? false,
		});

		if (success) {
			void vscode.window.showInformationMessage('Highlight added to the current file.');
		}
	}

	async removeHighlightRule() {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			void vscode.window.showErrorMessage('No active editor found.');
			return;
		}

		const uri = editor.document.uri.toString();
		const rules = this.rulesByDocument.get(uri);

		if (!rules || rules.length === 0) {
			void vscode.window.showInformationMessage('No highlights exist for the current file.');
			return;
		}

		const pick = await vscode.window.showQuickPick(
			rules.map((rule) => ({
				label: rule.pattern,
				description: this.describeRule(rule),
				detail: `Color: ${rule.color}`,
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

		if (this.removeRule(uri, pick.rule.id)) {
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

		const uri = editor.document.uri.toString();
		const rules = this.rulesByDocument.get(uri);
		if (!rules || rules.length === 0) {
			void vscode.window.showInformationMessage('There are no highlights to clear.');
			return;
		}

		for (const rule of rules) {
			this.clearRuleDecorations(uri, rule);
			rule.decoration.dispose();
		}
		this.rulesByDocument.delete(uri);
		this.notifyRulesChanged();
		void vscode.window.showInformationMessage('All highlights cleared for this file.');
	}

	public getRuleSnapshots(uri?: string | null): PanelRule[] {
		if (!uri) {
			return [];
		}

		const rules = this.rulesByDocument.get(uri) ?? [];
		return rules.map((rule) => {
			const { decoration: _decoration, ...rest } = rule;
			return { ...rest, matchCount: rule.matchCount ?? 0, description: this.describeRule(rule) };
		});
	}

	public updateRulePattern(uri: string, ruleId: string, pattern: string): boolean {
		const rule = this.getRule(uri, ruleId);
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
		this.updateDecorationsForUri(uri);
		this.notifyRulesChanged();
		return true;
	}

	public toggleRuleOption(uri: string, ruleId: string, option: RuleOptionKey) {
		const rule = this.getRule(uri, ruleId);
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

		this.updateDecorationsForUri(uri);
		this.notifyRulesChanged();
	}

	public updateRuleColor(uri: string, ruleId: string, color: string): boolean {
		const rule = this.getRule(uri, ruleId);
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
		this.updateDecorationsForUri(uri);
		this.notifyRulesChanged();
		return true;
	}

	public deleteRule(uri: string, ruleId: string): boolean {
		const removed = this.removeRule(uri, ruleId);
		if (removed) {
			this.notifyRulesChanged();
		}
		return removed;
	}

	public navigateToMatch(uri: string, ruleId: string, direction: NavigationDirection) {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.uri.toString() !== uri) {
			void vscode.window.showInformationMessage('Open the target document to navigate between matches.');
			return;
		}

		const rule = this.getRule(uri, ruleId);
		if (!rule) {
			return;
		}

		const matches = this.findMatches(editor.document, rule);
		if (matches.length === 0) {
			void vscode.window.showInformationMessage(`No matches were found for "${rule.pattern}".`);
			return;
		}

		const doc = editor.document;
		const selection = editor.selection;
		const anchorOffset = doc.offsetAt(selection.anchor);
		const activeOffset = doc.offsetAt(selection.active);
		const currentStart = Math.min(anchorOffset, activeOffset);
		const currentEnd = Math.max(anchorOffset, activeOffset);
		let target: vscode.Range;

		if (direction === 'next') {
			target = matches.find((range) => doc.offsetAt(range.start) > currentEnd) ?? matches[0];
		} else {
			target =
				[...matches].reverse().find((range) => doc.offsetAt(range.end) < currentStart) ??
				matches[matches.length - 1];
		}

		editor.selection = new vscode.Selection(target.start, target.end);
		editor.revealRange(target, vscode.TextEditorRevealType.InCenter);
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

		const created = this.createRuleFromOptions(editor, {
			pattern: trimmedPattern,
			color: trimmedColor,
			matchCase: payload.matchCase,
			matchWholeWord: payload.matchWholeWord,
			useRegex: payload.useRegex,
		});

		if (created) {
			void vscode.window.showInformationMessage('Highlight added to the current file.');
		}
	}

	private createRuleFromOptions(
		editor: vscode.TextEditor,
		options: Omit<CreateRulePayload, 'documentUri'>
	): boolean {
		const pattern = options.pattern.trim();
		if (!pattern) {
			void vscode.window.showErrorMessage('Enter a value to highlight.');
			return false;
		}

		const color = options.color.trim();
		if (!color) {
			void vscode.window.showErrorMessage('Pick a highlight color.');
			return false;
		}

		const uri = editor.document.uri.toString();
		const rule: HighlightRule = {
			id: HighlightController.createId(),
			pattern,
			color,
			matchCase: options.matchCase,
			matchWholeWord: options.matchWholeWord,
			useRegex: options.useRegex,
			decoration: HighlightController.createDecoration(color),
			documentUri: uri,
			matchCount: 0,
		};

		if (rule.useRegex) {
			try {
				this.buildRegExp(rule);
			} catch (error) {
				rule.decoration.dispose();
				const message = error instanceof Error ? error.message : String(error);
				void vscode.window.showErrorMessage(`Invalid regular expression: ${message}`);
				return false;
			}
		}

		const rules = this.rulesByDocument.get(uri) ?? [];
		rules.push(rule);
		this.rulesByDocument.set(uri, rules);

		this.applyRules(editor);
		this.notifyRulesChanged();
		return true;
	}

	private notifyRulesChanged() {
		this.onDidChangeRulesEmitter.fire();
	}

	private getRule(uri: string, ruleId: string): HighlightRule | undefined {
		const rules = this.rulesByDocument.get(uri);
		return rules?.find((rule) => rule.id === ruleId);
	}

	private removeRule(uri: string, ruleId: string): boolean {
		const rules = this.rulesByDocument.get(uri);
		if (!rules) {
			return false;
		}

		const index = rules.findIndex((rule) => rule.id === ruleId);
		if (index === -1) {
			return false;
		}

		const [removed] = rules.splice(index, 1);
		this.clearRuleDecorations(uri, removed);
		removed.decoration.dispose();
		if (rules.length === 0) {
			this.rulesByDocument.delete(uri);
		}

		this.updateDecorationsForUri(uri);
		return true;
	}

	private applyRules(editor: vscode.TextEditor) {
		const uri = editor.document.uri.toString();
		const rules = this.rulesByDocument.get(uri);
		if (!rules) {
			return;
		}

		for (const rule of rules) {
			const ranges = this.findMatches(editor.document, rule);
			rule.matchCount = ranges.length;
			editor.setDecorations(rule.decoration, ranges);
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
			ranges.push(new vscode.Range(start, end));
		}

		return ranges;
	}

	private buildRegExp(rule: HighlightRule, overridePattern?: string): RegExp {
		const sourcePattern = overridePattern ?? rule.pattern;
		const source = rule.useRegex
			? sourcePattern
			: HighlightController.escapeForRegExp(sourcePattern);
		const wrapped = rule.matchWholeWord ? `\\b${source}\\b` : source;
		const flags = `g${rule.matchCase ? '' : 'i'}`;
		return new RegExp(wrapped, flags);
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

	private clearRuleDecorations(uri: string, rule: HighlightRule) {
		const editors = vscode.window.visibleTextEditors.filter((editor) => editor.document.uri.toString() === uri);
		for (const editor of editors) {
			editor.setDecorations(rule.decoration, []);
		}
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
		return value.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
	}

	private static getReadableTextColor(color: string): string | undefined {
		const rgb = HighlightController.parseHexColor(color);
		if (!rgb) {
			return undefined;
		}

		const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
		return luminance > 0.6 ? '#1f1f1f' : '#ffffff';
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
	| (PanelMessageBase & { type: 'removeRule'; ruleId: string; documentUri: string })
	| (PanelMessageBase & { type: 'updatePattern'; ruleId: string; documentUri: string; pattern: string })
	| (PanelMessageBase & { type: 'updateColor'; ruleId: string; documentUri: string; color: string })
	| (PanelMessageBase & {
			type: 'toggleOption';
			ruleId: string;
			documentUri: string;
			option: RuleOptionKey;
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
					this.controller.deleteRule(message.documentUri, message.ruleId);
					break;
				case 'updatePattern':
					this.controller.updateRulePattern(message.documentUri, message.ruleId, message.pattern);
					break;
				case 'updateColor':
					this.controller.updateRuleColor(message.documentUri, message.ruleId, message.color);
					break;
				case 'toggleOption':
					this.controller.toggleRuleOption(message.documentUri, message.ruleId, message.option);
					break;
				case 'navigate':
					this.controller.navigateToMatch(message.documentUri, message.ruleId, message.direction);
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

		this.view.webview.postMessage({
			type: 'rulesUpdate',
			rules,
			activeUri: uri,
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

		.options-toggle-row,
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
			<div class="options-toggle-row" id="newRuleOptions">
				<button type="button" class="option-toggle" data-option="matchCase" title="Match Case (Aa)">Aa</button>
				<button type="button" class="option-toggle" data-option="matchWholeWord" title="Match Whole Word (W)">W</button>
				<button type="button" class="option-toggle" data-option="useRegex" title="Use Regular Expression (.*)">.*</button>
			</div>
			<div class="color-row">
				<input type="color" id="colorPicker" value="#00c4ff" aria-label="Highlight color">
				<input type="text" id="colorText" class="color-text-hidden" value="#00c4ff55" tabindex="-1" aria-hidden="true">
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
		};
		const listEl = document.getElementById('ruleList');
		const patternInput = document.getElementById('patternInput');
		const colorPicker = document.getElementById('colorPicker');
		const colorText = document.getElementById('colorText');
		const optionButtons = Array.from(document.querySelectorAll('#newRuleOptions .option-toggle'));
		const colorParserCanvas = document.createElement('canvas');
		const colorParser = colorParserCanvas.getContext('2d');
		const colorOverlay = document.getElementById('colorOverlay');
		const inlineColorPicker = document.getElementById('inlineColorPicker');
		const inlineColorText = document.getElementById('inlineColorText');
		const colorOverlayApply = document.getElementById('colorOverlayApply');
		const colorOverlayCancel = document.getElementById('colorOverlayCancel');
		let colorEditorState = null;

		applyOptionButtonState();

		const OPTION_META = [
			{ key: 'matchCase', label: 'Aa', title: 'Match Case' },
			{ key: 'matchWholeWord', label: 'W', title: 'Match Whole Word' },
			{ key: 'useRegex', label: '.*', title: 'Use Regular Expression' },
		];
		const BASE_COLORS = ['#00c4ff', '#ffd400', '#8ac926', '#ff595e', '#6a4c93', '#1982c4', '#ff924c', '#fb5607'];
		const DEFAULT_ALPHA = '80';

		setFormEnabled(false);

		function applyOptionButtonState() {
			optionButtons.forEach((button) => {
				const key = button.dataset.option;
				if (!key) {
					return;
				}
				button.classList.toggle('active', !!state.formOptions[key]);
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
				secondRow.appendChild(optionRow);
				secondRow.appendChild(colorButton);

				const matchBadge = document.createElement('div');
				matchBadge.className = 'match-count';
				updateMatchBadge(matchBadge, rule.matchCount);
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

		function updateMatchBadge(element, count) {
			if (!(element instanceof HTMLElement)) {
				return;
			}
			const numeric = Number.isFinite(count) ? Number(count) : 0;
			element.textContent = numeric.toString();
			element.title = numeric === 1 ? '1 hit' : numeric + ' hits';
			element.classList.toggle('has-matches', numeric > 0);
			element.classList.toggle('empty', numeric === 0);
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
						documentUri: row.dataset.uri,
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
			const documentUri = row.dataset.uri;
			if (!ruleId || !documentUri) {
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

			colorEditorState = { ruleId, documentUri, row, alphaSuffix };
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
			const { ruleId, documentUri, row, alphaSuffix } = colorEditorState;
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

			vscode.postMessage({ type: 'updateColor', ruleId, documentUri, color: nextColor });
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
				vscode.postMessage({ type: 'removeRule', ruleId, documentUri: uri });
				return;
			}

			if (target?.closest('.color-button')) {
				showColorOverlay(row);
				return;
			}

			if (target?.closest('.option-toggle')) {
				const optionButton = target.closest('.option-toggle');
				const optionKey = optionButton?.dataset.option;
				if (optionKey) {
					vscode.postMessage({ type: 'toggleOption', ruleId, documentUri: uri, option: optionKey });
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
					documentUri: state.activeUri,
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
