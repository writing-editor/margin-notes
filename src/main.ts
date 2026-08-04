import { Editor, MarkdownView, Notice, Plugin, TFile } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { AgentSettings, DEFAULT_SETTINGS, MarginNotesSettings, MarginNotesSettingTab } from './settings';
import { AgentProvider, seedAgentsFolder } from './agents';
import { loadSecretsFile, saveSecretsFile } from './secretsFile';
import { runtime, isMarginNotesEnabled } from './runtime';
import { noteMarkerField, forceMarginRefresh } from './noteMarkers';
import { linkMarkerField } from './linkMarkers';
import { registerLinkPreviewInvalidation, disposeAllLinkPreviews } from './linkPreview';
import { marginPanel, insertNoteAt } from './marginPanel';
import { mnTypeAutocomplete } from './typeAutocomplete';
import { runAgent } from './agentRunner';
import { readingModePostProcessor } from './readingMode';

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

    // One-time (per vault) creation of the agents folder with two starter
    // profile files, so a fresh install has a visible, editable example of
    // what an agent profile file looks like instead of two profiles baked
    // invisibly into the plugin's code. No-ops if the folder already
    // exists — see seedAgentsFolder's doc comment in agents.ts.
    void seedAgentsFolder(this.app, this.settings.agent.agentsFolder);

    this.registerEditorExtension([noteMarkerField, linkMarkerField, marginPanel, mnTypeAutocomplete]);
    this.addSettingTab(new MarginNotesSettingTab(this.app, this));
    this.applyMarginWidth();
    // Module-level cache in linkPreview.ts is shared across every open
    // editor's margin column, so this is registered once here rather than
    // per-editor — parallel to the rename/metadataCache listeners below,
    // which are also plugin-lifetime, not per-view.
    this.linkPreviewInvalidation = registerLinkPreviewInvalidation(this.app);

    // Reading-mode support: decoration only (no margin column — see
    // readingMode.ts's own top comment for the full history of why that
    // was cut). registerMarkdownPostProcessor itself has no per-leaf cost
    // while every open leaf is in Source/Live Preview — Obsidian only
    // invokes it when its OWN unrelated rendering pipeline decides to
    // render a Reading-mode block, which structurally cannot happen while
    // nothing is in Reading view.
    this.registerMarkdownPostProcessor(readingModePostProcessor);

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

    // Switching a leaf between Live Preview/Source and Reading mode does
    // NOT tear down and recreate the CM6 EditorView — MarkdownView.editor
    // is a required, always-present field regardless of which mode is
    // currently visible, so the CM6 instance itself is never the thing
    // that goes away. What DOES change on a mode switch is which mode's
    // DOM is currently visible, which can leave the editor's margin
    // column's own width/enablement check stale until something forces a
    // fresh check. scheduleRefresh() below (deferred by one frame, so
    // this doesn't act mid-transition before Obsidian has actually
    // finished swapping which mode's DOM is visible) re-checks and
    // repaints it on every such transition.
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.scheduleRefresh()));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.scheduleRefresh()));
  }

  onunload() {
    // registerEditorExtension/registerEvent handle their own teardown.
    this.linkPreviewInvalidation?.unregister();
    disposeAllLinkPreviews();
    if (this.refreshRaf !== null) cancelAnimationFrame(this.refreshRaf);
  }

  async runAgentCommand(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    await runAgent(this.app, this.settings, activeFile);
  }

  private refreshRaf: number | null = null;
  private refreshRetriesLeft = 0;

  /**
   * Coalesces active-leaf-change/layout-change into a short retry loop
   * instead of a single deferred attempt. A single requestAnimationFrame
   * deferral assumes Obsidian finishes remounting/attaching the CM6 view
   * for the leaf that just changed mode within exactly one frame — that
   * assumption was never actually confirmed (this plugin has no live
   * Obsidian instance available to verify it against), and if it's wrong
   * even occasionally, getCM6View(view.editor) in refreshAllEditors()
   * returns undefined for that leaf on the one attempt made, the dispatch
   * silently no-ops via optional chaining, and — critically — nothing
   * tries again afterward. That reproduces the exact "margin column stuck
   * empty until the file is closed and reopened" symptom this whole event
   * wiring exists to prevent, just with the failure moved one layer
   * deeper (from "no refresh attempt at all" to "one refresh attempt that
   * silently missed").
   *
   * Retrying across several frames removes the single-frame timing
   * assumption entirely: RETRY_FRAMES is a small, cheap upper bound (each
   * attempt is just a dispatch onto whichever CM6 views ARE currently
   * reachable — trivial cost even when most attempts are redundant), not
   * a guess at exactly which frame the remount finishes on.
   */
  private static readonly REFRESH_RETRY_FRAMES = 6;

  private scheduleRefresh() {
    this.refreshRetriesLeft = MarginNotesPlugin.REFRESH_RETRY_FRAMES;
    if (this.refreshRaf !== null) return; // a retry loop is already running — it'll pick up this reset count
    this.runRefreshRetry();
  }

  private runRefreshRetry = () => {
    this.refreshAllEditors();
    this.refreshRetriesLeft -= 1;
    if (this.refreshRetriesLeft > 0) {
      this.refreshRaf = requestAnimationFrame(this.runRefreshRetry);
    } else {
      this.refreshRaf = null;
    }
  };

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
    // calc() against Obsidian's own --font-text-size rather than a resolved
    // pixel number here, so chips keep tracking the user's editor font size
    // live if they change it later — no re-render/replug needed on this
    // plugin's side for that to take effect.
    document.body.style.setProperty(
      '--mn-chip-font-size',
      `calc(var(--font-text-size, 16px) * ${this.settings.chipFontRatio})`
    );
  }

  async loadSettings() {
    // loadData() reads whatever JSON happens to be in data.json — genuinely
    // untyped at the source, since it's arbitrary persisted disk content,
    // not something this plugin's own types can vouch for until it's been
    // merged against DEFAULT_SETTINGS below. Narrowed to a deep-partial
    // shape right here, at the one spot the untyped-ness actually enters,
    // rather than letting `any` flow through every `loaded.agent` access
    // that follows.
    //
    // `secrets` is deliberately NOT part of this type or the merge below —
    // API keys live in their own file, api-keys.json, sitting next to (not
    // inside) data.json specifically so a person can gitignore just that
    // one file without also gitignoring every other setting. See
    // secretsFile.ts's own top comment for the full reasoning.
    type PartialSettings = Partial<Omit<MarginNotesSettings, 'agent' | 'secrets'>> & {
      agent?: Partial<Omit<AgentSettings, 'modelByProvider'>> & { modelByProvider?: Partial<Record<AgentProvider, string>> };
    };
    const loaded = ((await this.loadData()) ?? {}) as PartialSettings;

    const secrets = await loadSecretsFile(this.app);

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...loaded,
      agent: {
        ...DEFAULT_SETTINGS.agent,
        ...(loaded.agent ?? {}),
        modelByProvider: { ...DEFAULT_SETTINGS.agent.modelByProvider, ...(loaded.agent?.modelByProvider ?? {}) },
      },
      secrets,
    };
  }

  async saveSettings() {
    // secrets is split out and saved to its own file (api-keys.json, via
    // saveSecretsFile) rather than through this.saveData — see
    // loadSettings' comment and secretsFile.ts for why. Destructuring it
    // out here means a plain object spread of `this.settings` — which is
    // what saveData ultimately serialises to data.json — never contains a
    // `secrets` key going forward, even accidentally: there's no `secrets`
    // property left on `rest` to serialise.
    const { secrets, ...rest } = this.settings;
    await Promise.all([this.saveData(rest), saveSecretsFile(this.app, secrets)]);
    runtime.settings = this.settings;
    this.refreshAllEditors();
  }
}