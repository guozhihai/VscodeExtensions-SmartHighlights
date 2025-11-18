# Smart Highlights

Smart Highlights lets you highlight any text in the active editor using custom colors and search options that mirror the built-in Find widget (match case, whole word, and regular expression).

## Features

- Maintain multiple highlight rules per file, each with independent search options and colors.
- Toggle match case, match whole word, and regular expression modes for every rule.
- Choose whether a rule applies only to the current file, every file in the workspace folder, or the entire workspace.
- Export and import your highlight rule sets to reuse them in other folders or projects.
- Remove a single highlight rule or clear all rules that apply to the current editor.
- Decorations react to document edits, so highlights stay aligned with changing content.

Use the Smart Highlights side panel to add, edit, or remove highlight rules. Each rule can target any text (plain string or regex) with independent search options and colors. Use any CSS color string (named colors, `rgba()`, or hex values such as `#00c4ff55`). When "Use Regular Expression" is selected the pattern follows the JavaScript syntax used by VS Code searches. Whole-word matching wraps the underlying pattern with `\b` boundaries.

## Highlight Panel

Open the **Smart Highlights** view from the Activity Bar to access a dedicated panel:

- An always-visible form lets you type the keyword/regex, flip the `Aa` / `W` / `.*` option icons (their state is remembered), and the color field automatically rotates to a new unused color each time you add a rule - just press Enter to create it instantly.
- Pick the scope ("Current File", "Workspace Folder", or "Entire Workspace") from the dropdown before submitting the form so the new rule lands exactly where you expect.
- Use the panel header buttons to export the current highlight set to a JSON file or import a previously saved set into the active file/folder.
- Each listed rule shows its pattern with a live color preview; the text color automatically adjusts for readability.
- Toggle the `Aa` / `W` / `.*` icons next to a rule to change its search mode, or click the pattern to edit it inline.
- Click the color swatch to choose a new color, or use the up/down buttons to move to the previous/next match in the file.
- Remove a rule with the X button, or rely on the Command Palette commands if you prefer prompts.

## Known Limitations

- Highlight rules are stored in memory only; they reset when VS Code reloads.
- Regular expressions and whole-word matches share the same JavaScript semantics as the VS Code Find widget, which may differ from other editors.

## Release Notes

See [CHANGELOG.md](CHANGELOG.md) for the full history.

## Build an Installer (VSIX)

1. Install dependencies (Node.js 20+): `npm install`
2. Bundle the extension and create `conditional-coloring-<version>.vsix`:
   ```bash
   npm run vsix
   ```
3. In VS Code choose **Extensions → … → Install from VSIX…** and pick the generated file.
