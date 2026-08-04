import { App, Notice, PluginSettingTab, Setting, SettingDefinitionItem, requireApiVersion } from 'obsidian';
import type MarginNotesPlugin from './main';
import { decryptSecret, encryptSecret, encryptionAvailable, secretStorageDescription } from './secureStorage';
import { AGENT_PROVIDERS, AgentProvider, DensityPosture, SpellingConvention, listAgentNames } from './agents';

export type TriggerMode = 'frontmatter' | 'folder' | 'all';
export type AgentScope = 'file' | 'selection' | 'vault';

export interface AgentSettings {
  provider: AgentProvider;
  /** Remembers the last model typed/picked per provider, so switching providers doesn't lose your place. */
  modelByProvider: Record<AgentProvider, string>;
  ollamaUrl: string;
  agentsFolder: string;
  /** Name of the last agent profile used, read from agentsFolder — remembered across restarts. */
  selectedAgent: string;
  scope: AgentScope;
  /**
   * Plan §2 — vault-relative folder AI-authored reports are written to
   * (see agents.ts's buildReportFilePath/writeOrAppendReport). Separate
   * from `agentsFolder` on purpose: that folder holds agent PROFILES
   * (instructions the person writes), this one holds report OUTPUT (files
   * the agent writes) — mixing outputs into the same folder as profile
   * definitions would make `listAgentNames`/`loadAgentPrompt` (which
   * treat every markdown file in `agentsFolder` as a profile) start
   * treating old reports as selectable agent profiles.
   */
  reportsFolder: string;
}

export interface SecretSettings {
  claudeKey: string;
  openaiKey: string;
  geminiKey: string;
}

export interface MarginNotesSettings {
  enabled: boolean;
  triggerMode: TriggerMode;
  frontmatterKey: string;
  folderPath: string;
  marginWidth: number;
  /**
   * Chip text size, expressed as a RATIO against Obsidian's own editor font
   * size (--font-text-size) rather than a fixed pixel value — so chips
   * scale automatically if the user changes their editor font size instead
   * of staying fixed regardless of it. 1.0 would match the main text
   * exactly; the default sits a bit below that since chips are secondary,
   * margin-adjacent content, not body text. Applied via the
   * --mn-chip-font-size CSS variable — see applyMarginWidth() in main.ts
   * and .mn-chip in styles.css.
   */
  chipFontRatio: number;
  /**
   * The margin chip column hides itself entirely once the editor pane's own
   * width drops below `marginWidth * narrowPaneRatio` — i.e. this is a
   * RATIO against the user's own configured margin width, not a fixed
   * pixel number. That matters because a fixed pixel threshold doesn't
   * scale with marginWidth: someone running a 360px margin needs a much
   * wider pane before chips stop feeling cramped than someone running a
   * 140px margin does, and a single fixed number can't be right for both.
   * A ratio stays proportionally correct across the whole marginWidth
   * range automatically. This is the PANE's width, not the window's —
   * opening two notes side-by-side (a split view) makes each pane
   * narrower without changing the window, and this setting is what catches
   * that case. Note-superscript numbers and underlined link text keep
   * rendering as normal — only the chip column itself hides. 0 disables
   * this check entirely (chips always show, however narrow the pane gets).
   */
  narrowPaneRatio: number;
  /**
   * When true, the margin chip column never renders on Obsidian Mobile
   * (phones specifically — Platform.isMobile; tablets get Obsidian's
   * desktop-style layout and are unaffected by this setting), regardless
   * of pane width. Same fallback as the narrow-pane case: superscripts and
   * underlined links keep working, only the chip column is skipped.
   */
  disableChipsOnMobile: boolean;
  agent: AgentSettings;
  /**
   * Plan §2.5 — genuine style/behaviour preferences promoted out of the
   * previously-hardcoded prompt block, kept at the TOP LEVEL (not nested
   * under `agent`) because they're cross-cutting: they apply no matter
   * which agent profile is running, so a per-agent markdown file in
   * `agentsFolder` doesn't need to restate them.
   */
  spelling: SpellingConvention;
  density: DensityPosture;
  /** Values here are already run through encryptSecret() — never plaintext at rest when a keychain is available. */
  secrets: SecretSettings;
}

export const DEFAULT_SETTINGS: MarginNotesSettings = {
  enabled: true,
  triggerMode: 'frontmatter',
  frontmatterKey: 'margin-notes',
  folderPath: 'book',
  marginWidth: 220,
  // Chip font size as a ratio of the editor's own font size (see interface
  // doc comment). 0.9 reads as clearly secondary to the main text without
  // being hard to read.
  chipFontRatio: 0.9,
  // Chips hide once the pane is narrower than marginWidth * this ratio (see
  // interface doc comment). 3.0 means: once the pane is less than 3x the
  // margin's own width, chips hide — at marginWidth's default of 220px
  // that's ~660px, close to the old fixed 700px default, but now it scales
  // correctly if the user changes marginWidth instead of staying fixed.
  narrowPaneRatio: 3.0,
  disableChipsOnMobile: true,
  agent: {
    provider: 'claude',
    modelByProvider: {
      claude: 'claude-sonnet-4-6',
      openai: 'gpt-5.2',
      gemini: 'gemini-3-pro',
      ollama: 'llama3.1',
    },
    ollamaUrl: 'http://localhost:11434',
    agentsFolder: 'agents',
    selectedAgent: 'Continuity checker',
    scope: 'file',
    reportsFolder: 'agents/reports',
  },
  // Matches the original hardcoded prompt wording byte-for-byte (see
  // agents.ts's DEFAULT_PROMPT_OPTIONS) — a fresh install or a settings
  // file that predates plan §2.5 behaves exactly as before.
  spelling: 'auto',
  density: 'balanced',
  secrets: {
    claudeKey: '',
    openaiKey: '',
    geminiKey: '',
  },
};

/**
 * Uses the imperative `display()` API rather than Obsidian 1.13.0's
 * declarative `getSettingDefinitions()`. That newer API needs
 * minAppVersion >= 1.13.0, and several settings here are inherently
 * dynamic (rows added/hidden per trigger mode, per-provider fields,
 * agent profiles discovered from a vault folder at render time) rather
 * than a static schema, so a straight migration isn't a drop-in. Per
 * Obsidian's own guidance, `display()` remains supported indefinitely
 * as a fallback — this is a deliberate deferral, not an oversight, and
 * should be revisited if/when minAppVersion is raised to 1.13.0+.
 */
export class MarginNotesSettingTab extends PluginSettingTab {
  plugin: MarginNotesPlugin;

  constructor(app: App, plugin: MarginNotesPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    this.render();
  }

  private async save() {
    await this.plugin.saveSettings();
  }

  /**
   * `update()` is a 1.13.0+ API (see class doc comment — this plugin's
   * minAppVersion is 1.7.2). It's only ever meaningful when the declarative
   * path is actually in effect, which itself only happens on 1.13.0+, so
   * this guard is never a behavior change — just what satisfies
   * obsidianmd/no-unsupported-api's static check, which can't see that
   * implication on its own.
   */
  private safeUpdate() {
    if (requireApiVersion('1.13.0')) this.update();
  }

  render(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    // ---------------------------------------------------------------- Notes
    new Setting(containerEl)
      .setName('Activation')
      .setHeading()
      .setDesc(
        'Margin notes only render for files that match the rule below. Everything else opens as a plain, ' +
          'unmodified Obsidian note — nothing about the editor changes for those files.'
      );

    new Setting(containerEl)
      .setName('Enable plugin')
      .setDesc('Turn margin notes off everywhere without disabling the plugin.')
      .addToggle((toggle) =>
        toggle.setValue(s.enabled).onChange(async (value) => {
          s.enabled = value;
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName('Which files get margin notes')
      .setDesc('Choose how a file opts in to margin notes.')
      .addDropdown((dd) =>
        dd
          .addOption('frontmatter', 'Frontmatter property')
          .addOption('folder', 'Folder path')
          .addOption('all', 'Every markdown file')
          .setValue(s.triggerMode)
          .onChange(async (value) => {
            s.triggerMode = value as TriggerMode;
            await this.save();
            this.render();
          })
      );

    if (s.triggerMode === 'frontmatter') {
      new Setting(containerEl)
        .setName('Frontmatter property')
        .setDesc('A file with this property set to true gets margin notes. Example: margin-notes: true')
        .addText((text) =>
          text.setValue(s.frontmatterKey).onChange(async (value) => {
            s.frontmatterKey = value.trim() || DEFAULT_SETTINGS.frontmatterKey;
            await this.save();
          })
        );
    }

    if (s.triggerMode === 'folder') {
      new Setting(containerEl)
        .setName('Folder path')
        .setDesc('Vault-relative folder. Files in this folder (and subfolders) get margin notes. Example: book')
        .addText((text) =>
          text.setValue(s.folderPath).onChange(async (value) => {
            s.folderPath = value.trim().replace(/^\/+|\/+$/g, '');
            await this.save();
          })
        );
    }

    new Setting(containerEl)
      .setName('Margin width')
      .setDesc('Space (in pixels) reserved on the right for note chips.')
      .addSlider((slider) =>
        slider
          .setLimits(300, 600, 10)
          .setValue(s.marginWidth)
          .onChange(async (value) => {
            s.marginWidth = value;
            await this.save();
            this.plugin.applyMarginWidth();
          })
      );

    new Setting(containerEl)
      .setName('Margin note font size')
      .setDesc(
        'Size of the text inside margin note chips, as a ratio of your editor\u2019s own font size \u2014 ' +
          '0.9x means chips render at 90% of the main text size. Scales automatically if you change your ' +
          'editor font size, rather than staying fixed.'
      )
      .addSlider((slider) =>
        slider
          .setLimits(0.6, 1.3, 0.05)
          .setValue(s.chipFontRatio)
          .onChange(async (value) => {
            s.chipFontRatio = value;
            await this.save();
            this.plugin.applyMarginWidth();
          })
      );

    new Setting(containerEl)
      .setName('Hide chips in narrow panes')
      .setDesc(
        'Chips hide once the pane gets narrower than this many times your margin width — e.g. at 3.0x ' +
          'and a 220px margin, chips hide below ~660px. Scales automatically if you change the margin ' +
          'width above. Superscript note numbers and underlined links keep working as normal — only the ' +
          'chip column hides. Set to 0 to never hide chips.'
      )
      .addSlider((slider) =>
        slider
          .setLimits(0, 6, 0.1)
          .setValue(s.narrowPaneRatio)
          .onChange(async (value) => {
            s.narrowPaneRatio = value;
            await this.save();
            this.plugin.refreshAllEditors();
          })
      );

    new Setting(containerEl)
      .setName('Hide chips on mobile')
      .setDesc(
        'Turn off the margin chip column on Obsidian Mobile phones (tablets are unaffected — they ' +
          'use the same desktop-style layout). Superscripts and underlined links still work; this ' +
          'only affects the chip column, which needs more horizontal room than most phones have.'
      )
      .addToggle((toggle) =>
        toggle.setValue(s.disableChipsOnMobile).onChange(async (value) => {
          s.disableChipsOnMobile = value;
          await this.save();
          this.plugin.refreshAllEditors();
        })
      );

    // ---------------------------------------------------------------- Agent
    new Setting(containerEl)
      .setName('Notes agent')
      .setHeading()
      .setDesc(
        'The agent can only insert new [mn.ai: ...] notes — it never edits your prose or existing notes. ' +
          'Every insertion is checked after the fact to confirm that held.'
      );

    new Setting(containerEl)
      .setName('Spelling convention')
      .setDesc('Applies to every agent run, regardless of which profile is selected.')
      .addDropdown((dd) =>
        dd
          .addOption('auto', 'Auto-detect (British unless text is clearly American)')
          .addOption('british', 'British')
          .addOption('american', 'American')
          .setValue(s.spelling)
          .onChange(async (value) => {
            s.spelling = value as SpellingConvention;
            await this.save();
          })
      );

    new Setting(containerEl)
      .setName('Note density')
      .setDesc(
        'How aggressively the agent flags issues, regardless of which profile is selected. Conservative for a ' +
          'near-final polish pass, Thorough for an early structural read.'
      )
      .addDropdown((dd) =>
        dd
          .addOption('conservative', 'Conservative')
          .addOption('balanced', 'Balanced')
          .addOption('thorough', 'Thorough')
          .setValue(s.density)
          .onChange(async (value) => {
            s.density = value as DensityPosture;
            await this.save();
          })
      );

    new Setting(containerEl)
      .setName('Provider')
      .addDropdown((dd) => {
        AGENT_PROVIDERS.forEach((p) => {
          dd.addOption(p.id, p.label);
        });
        dd.setValue(s.agent.provider).onChange((value) => {
          s.agent.provider = value as AgentProvider;
          void this.save().then(() => this.render());
        });
      });

    const providerMeta = AGENT_PROVIDERS.find((p) => p.id === s.agent.provider)!;

    new Setting(containerEl)
      .setName('Model')
      .setDesc(`Remembered separately for each provider. Currently using: ${providerMeta.label}.`)
      .addText((text) =>
        text.setValue(s.agent.modelByProvider[s.agent.provider]).onChange(async (value) => {
          s.agent.modelByProvider[s.agent.provider] = value.trim();
          await this.save();
        })
      );

    if (s.agent.provider === 'ollama') {
      new Setting(containerEl)
        .setName('Ollama URL')
        .addText((text) =>
          text.setValue(s.agent.ollamaUrl).onChange(async (value) => {
            s.agent.ollamaUrl = value.trim() || DEFAULT_SETTINGS.agent.ollamaUrl;
            await this.save();
          })
        );
    } else {
      const secretKey = providerMeta.secretField;
      // Shown ABOVE the field, not just in its small description line —
      // a person pasting an API key deserves to notice this before they
      // do it, not find it in fine print after. Only rendered when
      // encryption genuinely isn't in effect (see secureStorage.ts's
      // honest-fallback design) — a working OS keychain gets no banner.
      // Obsidian lets a vault's config folder be renamed away from the
      // default ".obsidian" (Vault.configDir reflects whatever it's
      // actually called for THIS vault) — these warnings tell the person
      // to go look at their own filesystem, so they should name the
      // folder that's actually there, not assume the default.
      //
      // API keys live in a SEPARATE file from every other setting —
      // api-keys.json, next to data.json — specifically so gitignoring
      // just the keys doesn't also gitignore the rest of the plugin's
      // settings. See secretsFile.ts's top comment for the full reasoning.
      // Both warnings below now name that exact file, since "gitignore
      // this one precise path" is a much more useful, directly actionable
      // instruction than the old "check whether your whole config folder
      // is ignored" — which would have meant gitignoring every other
      // setting too.
      const configDir = this.app.vault.configDir;
      const secretsFilePath = `${configDir}/plugins/margin-notes/api-keys.json`;
      if (!encryptionAvailable()) {
        const warning = containerEl.createEl('p', { cls: 'setting-item-description mn-secret-warning' });
        warning.createEl('strong', { text: '\u26a0\ufe0f ' });
        warning.appendText(secretStorageDescription() + ' ');
        warning.appendText(
          `If this vault is a git repository, add "${secretsFilePath}" to your .gitignore \u2014 by default ` +
            'Obsidian does not gitignore anything for you, so this key would otherwise be committed in ' +
            'plain text. Only that one file needs to be ignored; every other setting still lives in ' +
            'data.json in the same folder and can stay tracked normally.'
        );
      }
      // Shown regardless of encryption state (unlike the git warning above),
      // because two different sync paths matter here: Obsidian Sync's own
      // docs confirm the config folder syncs even though hidden folders are
      // normally excluded, but its "community plugin" sync specifically
      // (which is what actually carries data.json — and, since the same
      // folder syncs as a unit, api-keys.json along with it) is OFF by
      // default and has to be turned on deliberately. A generic file-sync
      // tool (Dropbox, Syncthing, iCloud, etc.) has no such plugin-aware
      // distinction at all and syncs everything in the folder by default,
      // api-keys.json included. Either way it's a risk for a plaintext key,
      // and even a genuinely OS-keychain-encrypted key won't usefully
      // transfer to another device (safeStorage is machine-bound) — worth
      // a heads-up regardless of which encryption state is currently in
      // effect.
      containerEl.createEl('p', {
        cls: 'setting-item-description mn-secret-warning',
        text:
          `Heads up if you sync this vault: this key lives in "${secretsFilePath}". Obsidian Sync keeps ` +
          'that folder\u2019s plugin settings out unless you turn on its "community plugin" sync options ' +
          'yourself \u2014 but a generic file-sync tool (Dropbox, Syncthing, iCloud, etc.) has no such ' +
          'distinction and will sync the whole folder, this file included.',
      });
      new Setting(containerEl)
        .setName(`${providerMeta.label} API key`)
        .setDesc(secretStorageDescription())
        .addText((text) => {
          text.inputEl.type = 'password';
          text.setValue(decryptSecret(s.secrets[secretKey])).onChange(async (value) => {
            s.secrets[secretKey] = encryptSecret(value.trim());
            await this.save();
          });
        });
    }

    new Setting(containerEl)
      .setName('Agent profile')
      .setDesc(`Each markdown file in "${s.agent.agentsFolder}/" is a profile \u2014 pick which one runs.`)
      .addDropdown((dd) => {
        const names = listAgentNames(this.app, s.agent.agentsFolder);
        names.forEach((name) => {
          dd.addOption(name, name);
        });
        if (!names.includes(s.agent.selectedAgent) && names.length) s.agent.selectedAgent = names[0];
        dd.setValue(s.agent.selectedAgent).onChange((value) => {
          s.agent.selectedAgent = value;
          void this.save();
        });
      });

    new Setting(containerEl)
      .setName('Agent profiles folder')
      .setDesc(
        'Vault-relative folder (created at your vault root by default). Each markdown file in here is an ' +
          'agent profile \u2014 its content is the instructions given to the model, and its filename is the ' +
          'profile\u2019s name in the dropdown above. On first install this folder is created for you with three ' +
          'starter profiles: \u201cContinuity checker\u201d and \u201cLine editor\u201d write short inline margin notes, ' +
          'and \u201cEditorial summary\u201d writes one whole-document report to its own linked file (see the ' +
          '\u201cReports folder\u201d setting below) so you can see both note styles the plugin supports. Edit or ' +
          'delete any of them freely, or add your own .md file here to create a new profile. Renaming this ' +
          'setting only changes where the plugin looks; it won\u2019t move existing files for you.'
      )
      .addText((text) =>
        text.setValue(s.agent.agentsFolder).onChange(async (value) => {
          s.agent.agentsFolder = value.trim().replace(/^\/+|\/+$/g, '') || DEFAULT_SETTINGS.agent.agentsFolder;
          await this.save();
          this.render();
        })
      );


    new Setting(containerEl)
      .setName('Reports folder')
      .setDesc(
        'Vault-relative. Where the agent writes AI-authored report notes (e.g. a continuity report spanning ' +
          'the whole text) — separate from the agent profiles folder above, which holds instructions, not output.'
      )
      .addText((text) =>
        text.setValue(s.agent.reportsFolder).onChange(async (value) => {
          s.agent.reportsFolder = value.trim().replace(/^\/+|\/+$/g, '') || DEFAULT_SETTINGS.agent.reportsFolder;
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName('Scope')
      .setDesc('Run on your current selection, the whole active file, or every file that currently gets margin notes.')
      .addDropdown((dd) =>
        dd
          .addOption('selection', 'Current selection')
          .addOption('file', 'Current file')
          .addOption('vault', 'All margin-note files')
          .setValue(s.agent.scope)
          .onChange(async (value) => {
            s.agent.scope = value as AgentScope;
            await this.save();
          })
      );

    new Setting(containerEl).addButton((btn) =>
      btn
        .setButtonText('Run agent now')
        .setCta()
        .onClick(() => {
          this.plugin.runAgentCommand().catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            new Notice(`Agent run failed: ${message}`);
          });
        })
    );
  }

  /**
   * Declarative counterpart to render() above, for Obsidian 1.13.0+ (see
   * this class's own doc comment: additive, not a replacement — display()/
   * render() stay as the pre-1.13.0 fallback and are never invoked once
   * this method returns a non-empty array). Every row below mirrors a row
   * in render(); side effects and fallback-on-empty logic that used to live
   * in an .onChange() handler now live in setControlValue() instead, since
   * a declarative control has no onChange of its own.
   *
   * Key scheme: dot-delimited paths into `this.plugin.settings`
   * ('enabled', 'agent.provider', ...), plus two synthetic keys for the
   * two spots where the actual storage path is itself dynamic:
   * 'agent.modelByProvider.<provider>' and 'secrets.<secretField>'.
   * getControlValue/setControlValue parse these back apart below.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const s = this.plugin.settings;
    const providerMeta = AGENT_PROVIDERS.find((p) => p.id === s.agent.provider)!;

    // Discovered fresh every call (mirrors render() calling listAgentNames()
    // on each rebuild) — the self-correction below must run before the
    // 'Agent profile' dropdown's options are read.
    const agentNames = listAgentNames(this.app, s.agent.agentsFolder);
    if (!agentNames.includes(s.agent.selectedAgent) && agentNames.length) {
      s.agent.selectedAgent = agentNames[0];
    }

    const items: SettingDefinitionItem[] = [
      // ---------------------------------------------------------- Activation
      {
        name: 'Activation',
        desc:
          'Margin notes only render for files that match the rule below. Everything else opens as a plain, ' +
          'unmodified Obsidian note — nothing about the editor changes for those files.',
      },
      {
        name: 'Enable plugin',
        desc: 'Turn margin notes off everywhere without disabling the plugin.',
        control: { type: 'toggle', key: 'enabled' },
      },
      {
        name: 'Which files get margin notes',
        desc: 'Choose how a file opts in to margin notes.',
        control: {
          type: 'dropdown',
          key: 'triggerMode',
          options: {
            frontmatter: 'Frontmatter property',
            folder: 'Folder path',
            all: 'Every markdown file',
          },
        },
      },
      {
        name: 'Frontmatter property',
        desc: 'A file with this property set to true gets margin notes. Example: margin-notes: true',
        visible: () => this.plugin.settings.triggerMode === 'frontmatter',
        control: { type: 'text', key: 'frontmatterKey' },
      },
      {
        name: 'Folder path',
        desc: 'Vault-relative folder. Files in this folder (and subfolders) get margin notes. Example: book',
        visible: () => this.plugin.settings.triggerMode === 'folder',
        control: { type: 'text', key: 'folderPath' },
      },
      {
        name: 'Margin width',
        desc: 'Space (in pixels) reserved on the right for note chips.',
        control: { type: 'slider', key: 'marginWidth', min: 300, max: 600, step: 10 },
      },
      {
        name: 'Margin note font size',
        desc:
          'Size of the text inside margin note chips, as a ratio of your editor\u2019s own font size \u2014 ' +
          '0.9x means chips render at 90% of the main text size. Scales automatically if you change your ' +
          'editor font size, rather than staying fixed.',
        control: { type: 'slider', key: 'chipFontRatio', min: 0.6, max: 1.3, step: 0.05 },
      },
      {
        name: 'Hide chips in narrow panes',
        desc:
          'Chips hide once the pane gets narrower than this many times your margin width — e.g. at 3.0x ' +
          'and a 220px margin, chips hide below ~660px. Scales automatically if you change the margin ' +
          'width above. Superscript note numbers and underlined links keep working as normal — only the ' +
          'chip column hides. Set to 0 to never hide chips.',
        control: { type: 'slider', key: 'narrowPaneRatio', min: 0, max: 6, step: 0.1 },
      },
      {
        name: 'Hide chips on mobile',
        desc:
          'Turn off the margin chip column on Obsidian Mobile phones (tablets are unaffected — they ' +
          'use the same desktop-style layout). Superscripts and underlined links still work; this ' +
          'only affects the chip column, which needs more horizontal room than most phones have.',
        control: { type: 'toggle', key: 'disableChipsOnMobile' },
      },
      // --------------------------------------------------------------- Agent
      {
        name: 'Notes agent',
        desc:
          'The agent can only insert new [mn.ai: ...] notes — it never edits your prose or existing notes. ' +
          'Every insertion is checked after the fact to confirm that held.',
      },
      {
        name: 'Spelling convention',
        desc: 'Applies to every agent run, regardless of which profile is selected.',
        control: {
          type: 'dropdown',
          key: 'spelling',
          options: {
            auto: 'Auto-detect (British unless text is clearly American)',
            british: 'British',
            american: 'American',
          },
        },
      },
      {
        name: 'Note density',
        desc:
          'How aggressively the agent flags issues, regardless of which profile is selected. Conservative for a ' +
          'near-final polish pass, Thorough for an early structural read.',
        control: {
          type: 'dropdown',
          key: 'density',
          options: {
            conservative: 'Conservative',
            balanced: 'Balanced',
            thorough: 'Thorough',
          },
        },
      },
      {
        name: 'Provider',
        control: {
          type: 'dropdown',
          key: 'agent.provider',
          options: Object.fromEntries(AGENT_PROVIDERS.map((p) => [p.id, p.label])),
        },
      },
      {
        // desc has no function form in the installed .d.ts (SettingDefinitionBase.desc
        // is `string | DocumentFragment`), so the provider-derived text below is only
        // recomputed when getSettingDefinitions() itself is re-run — setControlValue()
        // calls this.safeUpdate() after changing 'agent.provider' specifically to force that.
        name: 'Model',
        desc: `Remembered separately for each provider. Currently using: ${providerMeta.label}.`,
        control: { type: 'text', key: `agent.modelByProvider.${s.agent.provider}` },
      },
      {
        name: 'Ollama URL',
        visible: () => this.plugin.settings.agent.provider === 'ollama',
        control: { type: 'text', key: 'agent.ollamaUrl' },
      },
      // The two warning paragraphs below are prose banners, not a control —
      // folded into one SettingDefinitionRender since they're adjacent prose
      // governed by overlapping (not identical) visibility conditions.
      {
        name: '',
        visible: () => this.plugin.settings.agent.provider !== 'ollama',
        searchable: false,
        render: (setting) => {
          setting.settingEl.remove();
          const configDir = this.app.vault.configDir;
          const secretsFilePath = `${configDir}/plugins/margin-notes/api-keys.json`;
          if (!encryptionAvailable()) {
            const warning = this.containerEl.createEl('p', { cls: 'setting-item-description mn-secret-warning' });
            warning.createEl('strong', { text: '\u26a0\ufe0f ' });
            warning.appendText(secretStorageDescription() + ' ');
            warning.appendText(
              `If this vault is a git repository, add "${secretsFilePath}" to your .gitignore \u2014 by default ` +
                'Obsidian does not gitignore anything for you, so this key would otherwise be committed in ' +
                'plain text. Only that one file needs to be ignored; every other setting still lives in ' +
                'data.json in the same folder and can stay tracked normally.'
            );
          }
          this.containerEl.createEl('p', {
            cls: 'setting-item-description mn-secret-warning',
            text:
              `Heads up if you sync this vault: this key lives in "${secretsFilePath}". Obsidian Sync keeps ` +
              'that folder\u2019s plugin settings out unless you turn on its "community plugin" sync options ' +
              'yourself \u2014 but a generic file-sync tool (Dropbox, Syncthing, iCloud, etc.) has no such ' +
              'distinction and will sync the whole folder, this file included.',
          });
        },
      },
      {
        name: `${providerMeta.label} API key`,
        desc: secretStorageDescription(),
        visible: () => this.plugin.settings.agent.provider !== 'ollama',
        // SettingTextControl has no input-type option (no way to mark it
        // "password" through the plain control schema), so this row stays
        // a manual Setting + addText(), exactly like render() does today.
        render: (setting) => {
          const currentSecretKey = AGENT_PROVIDERS.find((p) => p.id === this.plugin.settings.agent.provider)!
            .secretField;
          setting.addText((text) => {
            text.inputEl.type = 'password';
            text.setValue(decryptSecret(this.plugin.settings.secrets[currentSecretKey])).onChange(async (value) => {
              this.plugin.settings.secrets[currentSecretKey] = encryptSecret(value.trim());
              await this.save();
            });
          });
        },
      },
      {
        name: 'Agent profile',
        desc: `Each markdown file in "${s.agent.agentsFolder}/" is a profile \u2014 pick which one runs.`,
        control: {
          type: 'dropdown',
          key: 'agent.selectedAgent',
          options: Object.fromEntries(agentNames.map((name) => [name, name])),
        },
      },
      {
        name: 'Agent profiles folder',
        desc:
          'Vault-relative folder (created at your vault root by default). Each markdown file in here is an ' +
          'agent profile \u2014 its content is the instructions given to the model, and its filename is the ' +
          'profile\u2019s name in the dropdown above. On first install this folder is created for you with three ' +
          'starter profiles: \u201cContinuity checker\u201d and \u201cLine editor\u201d write short inline margin notes, ' +
          'and \u201cEditorial summary\u201d writes one whole-document report to its own linked file (see the ' +
          '\u201cReports folder\u201d setting below) so you can see both note styles the plugin supports. Edit or ' +
          'delete any of them freely, or add your own .md file here to create a new profile. Renaming this ' +
          'setting only changes where the plugin looks; it won\u2019t move existing files for you.',
        control: { type: 'text', key: 'agent.agentsFolder' },
      },
      {
        name: 'Reports folder',
        desc:
          'Vault-relative. Where the agent writes AI-authored report notes (e.g. a continuity report spanning ' +
          'the whole text) — separate from the agent profiles folder above, which holds instructions, not output.',
        control: { type: 'text', key: 'agent.reportsFolder' },
      },
      {
        name: 'Scope',
        desc: 'Run on your current selection, the whole active file, or every file that currently gets margin notes.',
        control: {
          type: 'dropdown',
          key: 'agent.scope',
          options: {
            selection: 'Current selection',
            file: 'Current file',
            vault: 'All margin-note files',
          },
        },
      },
      {
        name: '',
        searchable: false,
        render: (setting) => {
          setting.settingEl.addClass('mn-run-agent-row');
          setting.addButton((btn) =>
            btn
              .setButtonText('Run agent now')
              .setCta()
              .onClick(() => {
                this.plugin.runAgentCommand().catch((err: unknown) => {
                  const message = err instanceof Error ? err.message : String(err);
                  new Notice(`Agent run failed: ${message}`);
                });
              })
          );
        },
      },
    ];

    return items;
  }

  getControlValue(key: string): unknown {
    const s = this.plugin.settings;
    switch (key) {
      case 'enabled':
        return s.enabled;
      case 'triggerMode':
        return s.triggerMode;
      case 'frontmatterKey':
        return s.frontmatterKey;
      case 'folderPath':
        return s.folderPath;
      case 'marginWidth':
        return s.marginWidth;
      case 'chipFontRatio':
        return s.chipFontRatio;
      case 'narrowPaneRatio':
        return s.narrowPaneRatio;
      case 'disableChipsOnMobile':
        return s.disableChipsOnMobile;
      case 'spelling':
        return s.spelling;
      case 'density':
        return s.density;
      case 'agent.provider':
        return s.agent.provider;
      case 'agent.ollamaUrl':
        return s.agent.ollamaUrl;
      case 'agent.selectedAgent':
        return s.agent.selectedAgent;
      case 'agent.agentsFolder':
        return s.agent.agentsFolder;
      case 'agent.reportsFolder':
        return s.agent.reportsFolder;
      case 'agent.scope':
        return s.agent.scope;
      default:
        if (key.startsWith('agent.modelByProvider.')) {
          const provider = key.slice('agent.modelByProvider.'.length) as AgentProvider;
          return s.agent.modelByProvider[provider];
        }
        if (key.startsWith('secrets.')) {
          const secretField = key.slice('secrets.'.length) as keyof SecretSettings;
          return decryptSecret(s.secrets[secretField]);
        }
        throw new Error(`MarginNotesSettingTab.getControlValue: unrecognized key "${key}"`);
    }
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.settings;
    switch (key) {
      case 'enabled':
        s.enabled = value as boolean;
        await this.save();
        return;
      case 'triggerMode':
        s.triggerMode = value as TriggerMode;
        await this.save();
        // Flips visibility of the frontmatter-key / folder-path rows below.
        this.safeUpdate();
        return;
      case 'frontmatterKey':
        s.frontmatterKey = (value as string).trim() || DEFAULT_SETTINGS.frontmatterKey;
        await this.save();
        return;
      case 'folderPath':
        s.folderPath = (value as string).trim().replace(/^\/+|\/+$/g, '');
        await this.save();
        return;
      case 'marginWidth':
        s.marginWidth = value as number;
        await this.save();
        this.plugin.applyMarginWidth();
        return;
      case 'chipFontRatio':
        s.chipFontRatio = value as number;
        await this.save();
        this.plugin.applyMarginWidth();
        return;
      case 'narrowPaneRatio':
        s.narrowPaneRatio = value as number;
        await this.save();
        this.plugin.refreshAllEditors();
        return;
      case 'disableChipsOnMobile':
        s.disableChipsOnMobile = value as boolean;
        await this.save();
        this.plugin.refreshAllEditors();
        return;
      case 'spelling':
        s.spelling = value as SpellingConvention;
        await this.save();
        return;
      case 'density':
        s.density = value as DensityPosture;
        await this.save();
        return;
      case 'agent.provider':
        s.agent.provider = value as AgentProvider;
        await this.save();
        // Changes which of the Ollama-URL / API-key rows are visible, AND
        // the Model row's provider-derived desc text — both require a full
        // re-run of getSettingDefinitions(), not just a visibility re-check.
        this.safeUpdate();
        return;
      case 'agent.ollamaUrl':
        s.agent.ollamaUrl = (value as string).trim() || DEFAULT_SETTINGS.agent.ollamaUrl;
        await this.save();
        return;
      case 'agent.selectedAgent':
        s.agent.selectedAgent = value as string;
        await this.save();
        return;
      case 'agent.agentsFolder':
        s.agent.agentsFolder =
          (value as string).trim().replace(/^\/+|\/+$/g, '') || DEFAULT_SETTINGS.agent.agentsFolder;
        await this.save();
        // Affects the Agent-profile dropdown's discovered options above.
        this.safeUpdate();
        return;
      case 'agent.reportsFolder':
        s.agent.reportsFolder =
          (value as string).trim().replace(/^\/+|\/+$/g, '') || DEFAULT_SETTINGS.agent.reportsFolder;
        await this.save();
        return;
      case 'agent.scope':
        s.agent.scope = value as AgentScope;
        await this.save();
        return;
      default:
        if (key.startsWith('agent.modelByProvider.')) {
          const provider = key.slice('agent.modelByProvider.'.length) as AgentProvider;
          s.agent.modelByProvider[provider] = (value as string).trim();
          await this.save();
          return;
        }
        if (key.startsWith('secrets.')) {
          const secretField = key.slice('secrets.'.length) as keyof SecretSettings;
          s.secrets[secretField] = encryptSecret((value as string).trim());
          await this.save();
          return;
        }
        throw new Error(`MarginNotesSettingTab.setControlValue: unrecognized key "${key}"`);
    }
  }
}