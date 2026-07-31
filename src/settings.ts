import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type MarginNotesPlugin from './main';
import { decryptSecret, encryptSecret, secretStorageDescription } from './secureStorage';
import { AGENT_PROVIDERS, AgentProvider, listAgentNames } from './agents';

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
   * Below this editor-pane width (in pixels), the margin chip column hides
   * itself entirely — the pane is too narrow to reserve marginWidth px for
   * chips without squeezing the actual prose uncomfortably. This is the
   * PANE's width, not the window's — opening two notes side-by-side (a
   * split view) makes each pane narrower without changing the window, and
   * this setting is what catches that case. Note-superscript numbers and
   * underlined link text keep rendering as normal — only the chip column
   * itself hides. 0 disables this check entirely (chips always show,
   * however narrow the pane gets).
   */
  narrowPaneThreshold: number;
  /**
   * When true, the margin chip column never renders on Obsidian Mobile
   * (phones specifically — Platform.isMobile; tablets get Obsidian's
   * desktop-style layout and are unaffected by this setting), regardless
   * of pane width. Same fallback as the narrow-pane case: superscripts and
   * underlined links keep working, only the chip column is skipped.
   */
  disableChipsOnMobile: boolean;
  agent: AgentSettings;
  /** Values here are already run through encryptSecret() — never plaintext at rest when a keychain is available. */
  secrets: SecretSettings;
}

export const DEFAULT_SETTINGS: MarginNotesSettings = {
  enabled: true,
  triggerMode: 'frontmatter',
  frontmatterKey: 'margin-notes',
  folderPath: 'book',
  marginWidth: 220,
  // Below this pane width, chips hide (see interface doc comment). 700px is
  // roughly "a single note pane on a 13" laptop split into two side by
  // side" — narrower than that and marginWidth (default 220) starts eating
  // a genuinely uncomfortable fraction of the remaining prose width.
  narrowPaneThreshold: 700,
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
  },
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
          .setLimits(200, 460, 10)
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
        'Below this pane width, the margin chip column hides itself (e.g. when you split the ' +
          'editor into two notes side by side). Superscript note numbers and underlined links keep ' +
          'working as normal — only the chip column hides. Set to 0 to never hide chips.'
      )
      .addSlider((slider) =>
        slider
          .setLimits(0, 1000, 10)
          .setValue(s.narrowPaneThreshold)
          .setDynamicTooltip()
          .onChange(async (value) => {
            s.narrowPaneThreshold = value;
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