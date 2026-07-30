import { Editor, MarkdownView, Notice, Plugin, TFile } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { DEFAULT_SETTINGS, MarginNotesSettings, MarginNotesSettingTab } from './settings';
import { runtime, isMarginNotesEnabled } from './runtime';
import { noteMarkerField, forceMarginRefresh } from './noteMarkers';
import { linkMarkerField } from './linkMarkers';
import { registerLinkPreviewInvalidation, disposeAllLinkPreviews } from './linkPreview';
import { marginPanel, insertNoteAt } from './marginPanel';
import { mnTypeAutocomplete } from './typeAutocomplete';
import { runAgent } from './agentRunner';

// Obsidian's public Editor type doesn't expose the underlying CM6 EditorView,
// but every source/live-preview editor has one at editor.cm — the same
// unofficial-but-widely-used access point most CM6-touching community
// plugins rely on. Everything that reads this no-ops with a Notice instead
// of throwing if a future release removes it; the decorations themselves
// (registered via registerEditorExtension) don't depend on it at all.
function getCM6View(editor: Editor): EditorView | undefined {
  return (editor as unknown as { cm?: EditorView }).cm;
}

export default class MarginNotesPlugin extends Plugin {
  settings: MarginNotesSettings = DEFAULT_SETTINGS;
  private linkPreviewInvalidation: { unregister: () => void } | null = null;

  async onload() {
    await this.loadSettings();
    runtime.app = this.app;
    runtime.settings = this.settings;

    this.registerEditorExtension([noteMarkerField, linkMarkerField, marginPanel, mnTypeAutocomplete]);
    this.addSettingTab(new MarginNotesSettingTab(this.app, this));
    this.applyMarginWidth();
    // Module-level cache in linkPreview.ts is shared across every open
    // editor's margin column, so this is registered once here rather than
    // per-editor — parallel to the rename/metadataCache listeners below,
    // which are also plugin-lifetime, not per-view.
    this.linkPreviewInvalidation = registerLinkPreviewInvalidation(this.app);

    this.addCommand({
      id: 'insert-margin-note',
      name: 'Insert margin note',
      editorCallback: (editor, view) => {
        const file = view instanceof MarkdownView ? view.file : null;
        if (!isMarginNotesEnabled(file)) {
          new Notice('Margin notes are not enabled for this file — see plugin settings.');
          return;
        }
        const cmView = getCM6View(editor);
        if (!cmView) {
          new Notice('Margin Notes: could not reach the underlying editor.');
          return;
        }
        const pos = cmView.state.selection.main.to;
        // Drop an empty default-type marker and put the caret right inside
        // it — no modal. Typing "[mn." anywhere (including here, if this is
        // edited into "[mn.warning:" etc.) triggers the type autocomplete
        // in typeAutocomplete.ts.
        insertNoteAt(cmView, pos, null, '');
        cmView.dispatch({ selection: { anchor: pos + '[mn: '.length } });
        cmView.focus();
      },
    });

    this.addCommand({
      id: 'run-agent',
      name: 'Run notes agent (uses settings for scope/provider/profile)',
      callback: () => this.runAgentCommand(),
    });

    // Doc edits (including typing into frontmatter) already trigger the
    // decoration StateField's own recompute via tr.docChanged. These two
    // events cover the cases that change enablement WITHOUT a doc change in
    // the affected editor: a file moving across a folder-rule boundary, and
    // frontmatter edited through the Properties UI rather than by typing.
    this.registerEvent(this.app.vault.on('rename', () => this.refreshAllEditors()));
    this.registerEvent(this.app.metadataCache.on('changed', (file) => this.refreshAllEditors(file)));
  }

  onunload() {
    // registerEditorExtension/registerEvent handle their own teardown.
    this.linkPreviewInvalidation?.unregister();
    disposeAllLinkPreviews();
  }

  async runAgentCommand(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    await runAgent(this.app, this.settings, activeFile);
  }

  refreshAllEditors(onlyFile?: TFile) {
    this.app.workspace.getLeavesOfType('markdown').forEach((leaf) => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) return;
      if (onlyFile && view.file !== onlyFile) return;
      const cmView = getCM6View(view.editor);
      cmView?.dispatch({ effects: forceMarginRefresh.of(null) });
    });
  }

  applyMarginWidth() {
    document.body.style.setProperty('--mn-margin-width', `${this.settings.marginWidth}px`);
  }

  async loadSettings() {
    const loaded = (await this.loadData()) ?? {};
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...loaded,
      agent: {
        ...DEFAULT_SETTINGS.agent,
        ...(loaded.agent ?? {}),
        modelByProvider: { ...DEFAULT_SETTINGS.agent.modelByProvider, ...(loaded.agent?.modelByProvider ?? {}) },
      },
      secrets: { ...DEFAULT_SETTINGS.secrets, ...(loaded.secrets ?? {}) },
    };
  }

  async saveSettings() {
    await this.saveData(this.settings);
    runtime.settings = this.settings;
    this.refreshAllEditors();
  }
}