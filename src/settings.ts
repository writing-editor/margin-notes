import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type MarginNotesPlugin from './main';
import { decryptSecret, encryptSecret, secretStorageDescription } from './secureStorage';
import { AGENT_PROVIDERS, AgentProvider, DensityPosture, SpellingConvention, listAgentNames } from './agents';

export type TriggerMode = 'frontmatter' | 'folder' | 'all';
export type AgentScope = 'file' | 'selection' | 'vault';

export interface AgentSettings {
  provider: AgentProvider;
  /** Remembers the last model typed/picked per provider, so switching providers doesn't lose your place. */
  modelByProvider: Record<AgentProvider, string>;
  ollamaUrl: string;
  agentsFolder: string;
  /** Name of the last agent profile used (bundled or from agentsFolder) — remembered across restarts. */
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

  render(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    // ---------------------------------------------------------------- Notes
    containerEl.createEl('h2', { text: 'Margin notes' });
    containerEl.createEl('p', {
      text:
        'Margin notes only render for files that match the rule below. Everything else opens as a plain, ' +
        'unmodified Obsidian note — nothing about the editor changes for those files.',
      cls: 'setting-item-description',
    });

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
          .setLimits(140, 360, 10)
          .setValue(s.marginWidth)
          .setDynamicTooltip()
          .onChange(async (value) => {
            s.marginWidth = value;
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
          .setDynamicTooltip()
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
    containerEl.createEl('h2', { text: 'Notes agent' });
    containerEl.createEl('p', {
      text:
        'The agent can only insert new [mn.ai: ...] notes — it never edits your prose or existing notes. ' +
        'Every insertion is checked after the fact to confirm that held.',
      cls: 'setting-item-description',
    });

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
        AGENT_PROVIDERS.forEach((p) => dd.addOption(p.id, p.label));
        dd.setValue(s.agent.provider).onChange(async (value) => {
          s.agent.provider = value as AgentProvider;
          await this.save();
          this.render();
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
      .setDesc(`Bundled profiles, plus any markdown file in "${s.agent.agentsFolder}/" (filename shadows a bundled profile of the same name).`)
      .addDropdown((dd) => {
        const names = listAgentNames(this.app, s.agent.agentsFolder);
        names.forEach((name) => dd.addOption(name, name));
        if (!names.includes(s.agent.selectedAgent) && names.length) s.agent.selectedAgent = names[0];
        dd.setValue(s.agent.selectedAgent).onChange(async (value) => {
          s.agent.selectedAgent = value;
          await this.save();
        });
      });

    new Setting(containerEl)
      .setName('Agent profiles folder')
      .setDesc('Vault-relative. Each markdown file in here is an agent profile; its content is the instructions.')
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
          this.plugin.runAgentCommand().catch((err) => new Notice(`Agent run failed: ${err.message ?? err}`));
        })
    );
  }
}