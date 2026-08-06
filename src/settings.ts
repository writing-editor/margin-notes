import {
  AbstractInputSuggest,
  App,
  Notice,
  Platform,
  PluginSettingTab,
  Setting,
  SettingDefinitionItem,
  requireApiVersion,
} from 'obsidian';
import type MarginNotesPlugin from './main';
import {
  getNativeSecret,
  getNativeSecretById,
  listNativeSecretIds,
  nativeSecretStorageAvailable,
  secretStorageDescription,
  setNativeSecret,
} from './secretStorage';
import { sessionSecretOverride } from './runtime';
import { AGENT_PROVIDERS, AgentProvider, DensityPosture, SpellingConvention, listAgentNames } from './agents';

export type TriggerMode = 'frontmatter' | 'folder' | 'all';
export type AgentScope = 'file' | 'selection' | 'vault';

/**
 * Generic type-ahead suggester backing both the Model field and the
 * API-key field. `getCandidates` is called fresh on every keystroke
 * (not just once at construction) so the list can reflect settings
 * changes made earlier in the same render pass \u2014 e.g. switching
 * provider, which changes which model history or keychain ids are
 * relevant, without needing to reconstruct the whole suggest instance.
 * `onPick` fires only for an actual suggestion selection (click or
 * Enter-on-a-highlighted-row); free typing that never opens/selects
 * from the popover is handled entirely by the input's own normal
 * onChange, matching "leave the field to type your own text" from the
 * old dropdown+reveal-field pattern this replaces \u2014 but without that
 * pattern's re-render-the-whole-tab side effect (see the bug this
 * fixes: clicking "Custom\u2026" used to call this.render(), which does
 * containerEl.empty() and rebuilds every row, scrolling the settings
 * tab back to the top for no visible change).
 */
class SimpleSuggest extends AbstractInputSuggest<string> {
  constructor(
    app: App,
    inputEl: HTMLInputElement,
    private getCandidates: () => string[],
    private onPick: (value: string) => void
  ) {
    super(app, inputEl);
  }

  protected getSuggestions(query: string): string[] {
    const q = query.trim().toLowerCase();
    const candidates = this.getCandidates();
    if (!q) return candidates;
    return candidates.filter((c) => c.toLowerCase().includes(q));
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    el.setText(value);
  }

  selectSuggestion(value: string): void {
    this.setValue(value);
    this.close();
    this.onPick(value);
  }
}

export interface AgentSettings {
  provider: AgentProvider;
  /** Remembers the last model typed/picked per provider, so switching providers doesn't lose your place. */
  modelByProvider: Record<AgentProvider, string>;
  /**
   * Every distinct model name ever typed/picked per provider, most
   * recently used first, capped at MODEL_HISTORY_LIMIT per provider.
   * Purely additive to modelByProvider above (which still tracks just
   * the CURRENT value) — this is what powers the model dropdown's
   * "previously used" list, so switching providers or coming back to
   * one later offers a pick instead of re-typing the same string again.
   */
  modelHistoryByProvider: Record<AgentProvider, string[]>;
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

/** Cap on how many distinct model names are remembered per provider — a soft backstop against unbounded growth from typos/experiments, not a meaningful UX limit. */
const MODEL_HISTORY_LIMIT = 8;

/**
 * Adds `model` to the front of a provider's remembered model history,
 * de-duplicating (a re-picked/re-typed existing entry moves to the front
 * rather than appearing twice) and capping at MODEL_HISTORY_LIMIT. Pure
 * function — callers are responsible for writing the result back into
 * settings and persisting it.
 */
export function withModelRemembered(history: string[], model: string): string[] {
  const trimmed = model.trim();
  if (!trimmed) return history;
  return [trimmed, ...history.filter((m) => m !== trimmed)].slice(0, MODEL_HISTORY_LIMIT);
}

/**
 * The three provider API keys. On Obsidian 1.11.4+ these are never stored
 * here in memory-shape as plaintext-at-rest — reads/writes go straight
 * through secretStorage.ts to app.secretStorage. This interface still
 * exists because (a) agents.ts's AGENT_PROVIDERS needs `keyof
 * SecretSettings` to name which field a provider maps to, and (b) the
 * pre-1.11.4 fallback (see MarginNotesSettings.secretsFallback below)
 * still needs a plain object of this same shape to persist to data.json.
 */
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
   * The margin chip column hides itself entirely once the editor pane's
   * own width drops below this many pixels. This used to be expressed as
   * a RATIO against marginWidth (marginWidth * narrowPaneRatio) so it'd
   * scale automatically with whatever margin width was configured \u2014 but
   * that meant two sliders combined multiplicatively into a threshold
   * neither slider showed directly: at the extremes (marginWidth 600px,
   * ratio 6x) the result was a 3600px cutoff, wider than any real
   * monitor, so margins silently never showed and neither slider's
   * position made that obvious. A direct pixel value removes that
   * interaction entirely \u2014 what's set here is exactly the threshold,
   * full stop, regardless of what marginWidth happens to be. This is the
   * PANE's width, not the window's \u2014 opening two notes side-by-side (a
   * split view) makes each pane narrower without changing the window,
   * and this setting is what catches that case. Note-superscript numbers
   * and underlined link text keep rendering as normal \u2014 only the chip
   * column itself hides. 0 disables this check entirely (chips always
   * show, however narrow the pane gets).
   */
  narrowPaneCutoffPx: number;
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
  /**
   * Plaintext fallback ONLY for Obsidian versions before 1.11.4, where
   * app.secretStorage doesn't exist yet — see secretStorage.ts's module
   * comment and README.md's "Network use" section for why a fallback
   * exists at all instead of just raising minAppVersion. On 1.11.4+ this
   * stays at its empty-string defaults and is never read from or written
   * to; the real values live in Obsidian's native secret storage instead,
   * keyed by id (see secretStorage.ts), not in this settings object, so
   * they're never part of what saveData() persists to data.json on those
   * versions.
   */
  secretsFallback: SecretSettings;
  /**
   * Pre-1.11.4 only: the Agent section is collapsed behind a warning by
   * default on those Obsidian versions (see nativeSecretStorageAvailable
   * and the render()/getSettingDefinitions() gating below) because API
   * keys there can only be stored in plain text in this plugin's
   * data.json. Clicking through that warning once sets this to true
   * PERMANENTLY (persisted here, not session-only) \u2014 by design this is a
   * one-time "yes, I understand" a person grants themselves, not
   * something that re-locks on its own; nothing in this plugin ever sets
   * it back to false. On 1.11.4+ this flag is irrelevant (the section is
   * never gated there in the first place) but is still persisted as-is
   * for whenever someone downgrades Obsidian.
   */
  agentSectionUnlocked: boolean;
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
  // Chips hide once the pane is narrower than this many pixels (see
  // interface doc comment) — 660px matches the old default combination
  // of marginWidth 220px * ratio 3.0.
  narrowPaneCutoffPx: 660,
  disableChipsOnMobile: true,
  agent: {
    provider: 'claude',
    modelByProvider: {
      claude: 'claude-sonnet-4-6',
      openai: 'gpt-5.2',
      gemini: 'gemini-3-pro',
      ollama: 'llama3.1',
    },
    // Seeded with the same defaults as modelByProvider above, so the
    // dropdown has at least one entry on a fresh install instead of
    // starting empty.
    modelHistoryByProvider: {
      claude: ['claude-sonnet-4-6'],
      openai: ['gpt-5.2'],
      gemini: ['gemini-3-pro'],
      ollama: ['llama3.1'],
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
  secretsFallback: {
    claudeKey: '',
    openaiKey: '',
    geminiKey: '',
  },
  agentSectionUnlocked: false,
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

  /**
   * Reads one provider's API key regardless of which storage path is
   * active for this Obsidian version — native secret storage on 1.11.4+,
   * the plaintext data.json fallback below that. See secretStorage.ts's
   * module comment for why both paths exist. Never returns a session
   * override's value here — this is specifically "what's saved for this
   * provider," used to populate the field on render; the override is
   * applied separately, only at agent-run time (see agentRunner.ts), so
   * the settings tab always shows what's actually PERSISTED for this
   * provider, not a temporary borrowed value that could otherwise look
   * like it overwrote the saved key when it didn't.
   */
  private readSecret(field: keyof SecretSettings): string {
    if (nativeSecretStorageAvailable()) return getNativeSecret(this.app, field);
    return this.plugin.settings.secretsFallback[field];
  }

  /** Writes one provider's API key through whichever storage path is active. Persists settings afterward on the fallback path only — the native path has nothing in settings to persist. */
  private async writeSecret(field: keyof SecretSettings, value: string): Promise<void> {
    if (nativeSecretStorageAvailable()) {
      setNativeSecret(this.app, field, value);
      return;
    }
    this.plugin.settings.secretsFallback[field] = value;
    await this.save();
  }

  /**
   * Updates the CURRENT model value for `provider` on every keystroke —
   * deliberately NOT touching modelHistoryByProvider here (see
   * commitModelToHistory below for that). Keeping this separate is what
   * fixes a real bug: the old single setModel() called
   * withModelRemembered on every keystroke, so typing "claude-sonnet-4-6"
   * character by character pushed "c", "cl", "cla", ... into history one
   * partial prefix at a time, each overwriting the previous entry — by
   * the time typing finished, history held a handful of truncated
   * fragments instead of the one real model name, and the NEXT time
   * someone started typing, those fragments (not the actual
   * previously-used model) were what got suggested. Still saves on every
   * keystroke, same as before, so nothing typed is lost if settings
   * closes mid-edit.
   */
  private async setCurrentModel(provider: AgentProvider, model: string): Promise<void> {
    this.plugin.settings.agent.modelByProvider[provider] = model.trim();
    await this.save();
  }

  /**
   * Commits `model` into `provider`'s remembered history (most-recent-
   * first, deduped, capped — see withModelRemembered) — called on blur
   * (a real editing session just ended) or an explicit suggestion pick,
   * never on every keystroke. See setCurrentModel's doc comment above
   * for the bug this split fixes.
   */
  private async commitModelToHistory(provider: AgentProvider, model: string): Promise<void> {
    const trimmed = model.trim();
    if (!trimmed) return;
    const s = this.plugin.settings;
    s.agent.modelByProvider[provider] = trimmed;
    s.agent.modelHistoryByProvider[provider] = withModelRemembered(
      s.agent.modelHistoryByProvider[provider] ?? [],
      trimmed
    );
    await this.save();
  }

  /**
   * Renders the "Model" row as a single type-or-pick text field: typing
   * freely just sets the model as before, and a suggestion popover
   * (backed by SimpleSuggest) offers this provider's remembered model
   * history without requiring a separate dropdown or a second "Custom"
   * field to reveal. Replaces the old dropdown+reveal-field pair, which
   * had a real bug \u2014 picking "Custom\u2026" there called this.render(),
   * which does containerEl.empty() and rebuilds the WHOLE settings tab,
   * visibly scrolling it back to the top for what should be a no-op
   * local change. This field never calls render() on typing or picking,
   * so no scroll jump. Used by the imperative render() path;
   * getSettingDefinitions() below wires the same SimpleSuggest onto its
   * own text control since it builds its Setting differently.
   */
  private renderModelSetting(containerEl: HTMLElement, provider: AgentProvider): void {
    const providerMeta = AGENT_PROVIDERS.find((p) => p.id === provider)!;
    new Setting(containerEl)
      .setName('Model')
      .setDesc(
        `Remembered separately for each provider. Currently using: ${providerMeta.label}. Type a model ` +
          'name, or start typing to see previously used ones.'
      )
      .addText((text) => {
        text.setValue(this.plugin.settings.agent.modelByProvider[provider] ?? '').onChange(async (value) => {
          await this.setCurrentModel(provider, value);
        });
        // Commits to history on blur (editing session ended), not on
        // every keystroke — see setCurrentModel/commitModelToHistory's
        // doc comments for the bug this avoids.
        text.inputEl.addEventListener('blur', () => {
          void this.commitModelToHistory(provider, text.getValue());
        });
        new SimpleSuggest(
          this.app,
          text.inputEl,
          () => this.plugin.settings.agent.modelHistoryByProvider[provider] ?? [],
          (value) => {
            text.setValue(value);
            void this.commitModelToHistory(provider, value);
          }
        );
      });
  }

  /**
   * Renders the API-key row for `provider` as a type-or-pick text field,
   * mirroring renderModelSetting above but for keychain ids instead of
   * model names \u2014 see the module-level SimpleSuggest class. Typing or
   * pasting a value that ISN'T one of the suggested ids is treated as a
   * fresh key and written straight to this provider's own dedicated
   * secret slot via writeSecret, exactly like the old plain-text-input
   * behavior. Picking an EXISTING suggested id, in contrast, does NOT
   * touch this provider's own slot at all \u2014 it's a "borrow this other
   * stored key just for now" (see runtime.ts's sessionSecretOverride
   * doc comment): the picked id's value is loaded and kept only in that
   * in-memory session map, used by agent runs ahead of this provider's
   * saved key, and forgotten the moment Obsidian restarts or the plugin
   * reloads. That split \u2014 typing always saves, picking never overwrites
   * \u2014 is what lets someone try a different already-stored key
   * temporarily without disturbing what's actually saved for this
   * provider.
   *
   * The field is never pre-filled with the actual secret value (unlike
   * the old plain-text field, which showed the stored key masked behind
   * type="password" but still populated it) \u2014 stored keys are
   * write-only here, shown only as their id in the placeholder/suggestion
   * list, never as their value, so nothing sensitive ever round-trips
   * back into the DOM on render.
   */
  private renderApiKeySetting(containerEl: HTMLElement, provider: AgentProvider): void {
    const providerMeta = AGENT_PROVIDERS.find((p) => p.id === provider)!;
    const secretKey = providerMeta.secretField;
    const hasSavedKey = this.readSecret(secretKey).length > 0;
    const borrowed = sessionSecretOverride[provider];

    new Setting(containerEl)
      .setName(`${providerMeta.label} API key`)
      .setDesc(
        (borrowed
          ? 'Temporarily using a different stored key for this session \u2014 not saved, and forgotten next time ' +
            'Obsidian restarts. '
          : hasSavedKey
            ? 'A key is already saved for this provider. '
            : '') + secretStorageDescription()
      )
      .addText((text) => {
        text.inputEl.type = 'password';
        text.inputEl.placeholder = hasSavedKey ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (saved \u2014 paste to replace)' : 'Paste an API key';
        // Deliberately starts blank even when a key is saved (see doc
        // comment above) \u2014 typing/pasting here always means "save a new
        // key," never "here's your existing one to edit."
        text.setValue('');
        text.onChange(async (value) => {
          const trimmed = value.trim();
          if (!trimmed) return;
          // A typed/pasted value always saves to this provider's own
          // slot, exactly like before \u2014 selecting a suggestion instead
          // goes through SimpleSuggest's onPick below, which returns
          // early before this onChange's save ever runs (see that
          // handler's own comment).
          await this.writeSecret(secretKey, trimmed);
          delete sessionSecretOverride[provider];
          this.render();
        });
        // nativeSecretStorageAvailable() gates this pre-1.11.4 too, same
        // as listNativeSecretIds/getNativeSecretById themselves \u2014 no
        // suggestions to offer at all on those versions, since nothing's
        // ever written to a real keychain there.
        if (nativeSecretStorageAvailable()) {
          new SimpleSuggest(
            this.app,
            text.inputEl,
            () => listNativeSecretIds(this.app).filter((id) => id !== secretKey),
            (pickedId) => {
              // Picking an existing id borrows its value for this
              // session only \u2014 does NOT call writeSecret, so this
              // provider's own saved key (if any) is left untouched.
              // text.onChange above never fires for a programmatic
              // setValue from selectSuggestion (Obsidian's TextComponent
              // only fires its change listener on real input events),
              // so there's no risk of this accidentally re-triggering
              // the save path.
              const borrowedValue = getNativeSecretById(this.app, pickedId);
              sessionSecretOverride[provider] = borrowedValue;
              text.setValue('');
              this.render();
            }
          );
        }
      });
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
          .addOption('all', 'Every Markdown file')
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

    // Margin width, chip font ratio, and the narrow-pane hide ratio only
    // ever affect the desktop-style chip column — margins are unconditionally
    // disabled on mobile phones (see the mobileBlocked check in
    // marginPanel.ts's updateChipsAllowed(), which is not itself gated by
    // the disableChipsOnMobile setting's value), so these three controls
    // have literally no effect there and are hidden rather than shown as
    // dead, confusing settings. Tablets are unaffected by this hide, since
    // they use the same desktop-style layout as desktop itself.
    if (!Platform.isMobile) {
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
          'Chips hide once the pane gets narrower than this many pixels. Superscript note numbers and ' +
            'underlined links keep working as normal — only the chip column hides. Set to 0 to never hide chips.'
        )
        .addSlider((slider) =>
          slider
            .setLimits(0, 1200, 10)
            .setValue(s.narrowPaneCutoffPx)
            .onChange(async (value) => {
              s.narrowPaneCutoffPx = value;
              await this.save();
              this.plugin.refreshAllEditors();
            })
        );
    }


    // "Hide chips on mobile" itself is not shown on mobile, for the same
    // reason as the three controls above: margins are unconditionally off
    // on phones already (see comment above), so this toggle has nothing
    // left to turn off there — it's fixed, not configurable, on that
    // platform.
    if (!Platform.isMobile) {
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
    }

    // ---------------------------------------------------------------- Agent
    new Setting(containerEl)
      .setName('Notes agent')
      .setHeading()
      .setDesc(
        'The agent can only insert new [mn.ai: ...] notes — it never edits your prose or existing notes. ' +
          'Every insertion is checked after the fact to confirm that held.'
      );

    // Pre-1.11.4, there's no OS-keychain-backed storage at all — any API
    // key set up below would sit in plain text in this plugin's
    // data.json (see secretStorage.ts's module comment). Rather than
    // just warning ABOVE the key field like before, the whole section is
    // collapsed behind that warning until the person explicitly clicks
    // through — a person shouldn't have to scroll past a wall of agent
    // configuration to discover, only once they reach the key field
    // itself, that it's going to be stored insecurely. Once clicked,
    // agentSectionUnlocked is set permanently (see its doc comment on
    // MarginNotesSettings) — this is a one-time acknowledgement, not
    // something that re-locks itself.
    if (!nativeSecretStorageAvailable() && !s.agentSectionUnlocked) {
      const configDir = this.app.vault.configDir;
      const dataFilePath = `${configDir}/plugins/margin-notes/data.json`;
      const warning = containerEl.createEl('p', { cls: 'setting-item-description mn-secret-warning' });
      warning.createEl('strong', { text: '\u26a0\ufe0f ' });
      warning.appendText(secretStorageDescription() + ' ');
      warning.appendText(
        `If this vault is a git repository or synced with a generic file-sync tool (Dropbox, Syncthing, ` +
          `iCloud, etc.), that means any key you set up below travels in plain text wherever ` +
          `"${dataFilePath}" goes. Upgrading Obsidian to 1.11.4 or later moves it into encrypted, ` +
          'OS-keychain-backed storage automatically instead.'
      );
      new Setting(containerEl).addButton((btn) =>
        btn.setButtonText('Show agent settings anyway').onClick(() => {
          s.agentSectionUnlocked = true;
          void this.save().then(() => this.render());
        })
      );
      return;
    }

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

    this.renderModelSetting(containerEl, s.agent.provider);

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
      // Native-secret-storage-unavailable warning used to render here,
      // directly above the key field — now folded into the whole-section
      // gate above, so it's seen before anything else in this section
      // rather than only once someone scrolls this far.
      this.renderApiKeySetting(containerEl, s.agent.provider);
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
            all: 'Every Markdown file',
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
        visible: () => !Platform.isMobile,
        control: { type: 'slider', key: 'marginWidth', min: 300, max: 600, step: 10 },
      },
      {
        name: 'Margin note font size',
        desc:
          'Size of the text inside margin note chips, as a ratio of your editor\u2019s own font size \u2014 ' +
          '0.9x means chips render at 90% of the main text size. Scales automatically if you change your ' +
          'editor font size, rather than staying fixed.',
        visible: () => !Platform.isMobile,
        control: { type: 'slider', key: 'chipFontRatio', min: 0.6, max: 1.3, step: 0.05 },
      },
      {
        name: 'Hide chips in narrow panes',
        desc:
          'Chips hide once the pane gets narrower than this many pixels. Superscript note numbers and ' +
          'underlined links keep working as normal — only the chip column hides. Set to 0 to never hide chips.',
        visible: () => !Platform.isMobile,
        control: { type: 'slider', key: 'narrowPaneCutoffPx', min: 0, max: 1200, step: 10 },
      },
      {
        name: 'Hide chips on mobile',
        desc:
          'Turn off the margin chip column on Obsidian Mobile phones (tablets are unaffected — they ' +
          'use the same desktop-style layout). Superscripts and underlined links still work; this ' +
          'only affects the chip column, which needs more horizontal room than most phones have.',
        visible: () => !Platform.isMobile,
        control: { type: 'toggle', key: 'disableChipsOnMobile' },
      },
      // --------------------------------------------------------------- Agent
      {
        name: 'Notes agent',
        desc:
          'The agent can only insert new [mn.ai: ...] notes — it never edits your prose or existing notes. ' +
          'Every insertion is checked after the fact to confirm that held.',
      },
      // Locked state: pre-1.11.4 with agentSectionUnlocked still false —
      // warning + unlock button only, nothing else in the section. See
      // render()'s matching gate above for the full reasoning (kept in
      // sync with this one; they gate the same flag the same way).
      {
        name: '',
        visible: () => !nativeSecretStorageAvailable() && !this.plugin.settings.agentSectionUnlocked,
        searchable: false,
        render: (setting) => {
          setting.settingEl.remove();
          const configDir = this.app.vault.configDir;
          const dataFilePath = `${configDir}/plugins/margin-notes/data.json`;
          const warning = this.containerEl.createEl('p', { cls: 'setting-item-description mn-secret-warning' });
          warning.createEl('strong', { text: '\u26a0\ufe0f ' });
          warning.appendText(secretStorageDescription() + ' ');
          warning.appendText(
            `If this vault is a git repository or synced with a generic file-sync tool (Dropbox, Syncthing, ` +
              `iCloud, etc.), that means any key you set up below travels in plain text wherever ` +
              `"${dataFilePath}" goes. Upgrading Obsidian to 1.11.4 or later moves it into encrypted, ` +
              'OS-keychain-backed storage automatically instead.'
          );
          new Setting(this.containerEl).addButton((btn) =>
            btn.setButtonText('Show agent settings anyway').onClick(() => {
              this.plugin.settings.agentSectionUnlocked = true;
              void this.save().then(() => this.safeUpdate());
            })
          );
        },
      },
      {
        name: 'Spelling convention',
        desc: 'Applies to every agent run, regardless of which profile is selected.',
        visible: () => nativeSecretStorageAvailable() || this.plugin.settings.agentSectionUnlocked,
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
        visible: () => nativeSecretStorageAvailable() || this.plugin.settings.agentSectionUnlocked,
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
        visible: () => nativeSecretStorageAvailable() || this.plugin.settings.agentSectionUnlocked,
        control: {
          type: 'dropdown',
          key: 'agent.provider',
          options: Object.fromEntries(AGENT_PROVIDERS.map((p) => [p.id, p.label])),
        },
      },
      {
        // No `control` schema entry fits here (see renderModelSetting's
        // own doc comment above — a type-or-pick suggest field isn't one
        // of the declarative control types), so this stays a manual
        // `render:`, matching renderModelSetting exactly.
        name: 'Model',
        desc: `Remembered separately for each provider. Currently using: ${providerMeta.label}.`,
        visible: () => nativeSecretStorageAvailable() || this.plugin.settings.agentSectionUnlocked,
        render: (setting) => {
          const provider = this.plugin.settings.agent.provider;
          setting.addText((text) => {
            text.setValue(this.plugin.settings.agent.modelByProvider[provider] ?? '').onChange(async (value) => {
              await this.setCurrentModel(provider, value);
            });
            text.inputEl.addEventListener('blur', () => {
              void this.commitModelToHistory(provider, text.getValue());
            });
            new SimpleSuggest(
              this.app,
              text.inputEl,
              () => this.plugin.settings.agent.modelHistoryByProvider[provider] ?? [],
              (value) => {
                text.setValue(value);
                void this.commitModelToHistory(provider, value);
              }
            );
          });
        },
      },
      {
        name: 'Ollama URL',
        visible: () =>
          (nativeSecretStorageAvailable() || this.plugin.settings.agentSectionUnlocked) &&
          this.plugin.settings.agent.provider === 'ollama',
        control: { type: 'text', key: 'agent.ollamaUrl' },
      },
      {
        // Mirrors renderApiKeySetting above exactly — see that method's
        // doc comment for the full save-vs-borrow reasoning. Stays a
        // manual `render:` for the same reason as Model above (no
        // declarative control type fits a suggest-backed text field),
        // plus SettingTextControl has no input-type option to mark it
        // "password" through the plain control schema either way.
        name: `${providerMeta.label} API key`,
        visible: () =>
          (nativeSecretStorageAvailable() || this.plugin.settings.agentSectionUnlocked) &&
          this.plugin.settings.agent.provider !== 'ollama',
        render: (setting) => {
          const provider = this.plugin.settings.agent.provider;
          const secretKey = AGENT_PROVIDERS.find((p) => p.id === provider)!.secretField;
          const hasSavedKey = this.readSecret(secretKey).length > 0;
          const borrowed = sessionSecretOverride[provider];
          setting.setDesc(
            (borrowed
              ? 'Temporarily using a different stored key for this session \u2014 not saved, and forgotten next ' +
                'time Obsidian restarts. '
              : hasSavedKey
                ? 'A key is already saved for this provider. '
                : '') + secretStorageDescription()
          );
          setting.addText((text) => {
            text.inputEl.type = 'password';
            text.inputEl.placeholder = hasSavedKey
              ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (saved \u2014 paste to replace)'
              : 'Paste an API key';
            text.setValue('');
            text.onChange(async (value) => {
              const trimmed = value.trim();
              if (!trimmed) return;
              await this.writeSecret(secretKey, trimmed);
              delete sessionSecretOverride[provider];
              this.safeUpdate();
            });
            if (nativeSecretStorageAvailable()) {
              new SimpleSuggest(
                this.app,
                text.inputEl,
                () => listNativeSecretIds(this.app).filter((id) => id !== secretKey),
                (pickedId) => {
                  sessionSecretOverride[provider] = getNativeSecretById(this.app, pickedId);
                  text.setValue('');
                  this.safeUpdate();
                }
              );
            }
          });
        },
      },
      {
        name: 'Agent profile',
        desc: `Each markdown file in "${s.agent.agentsFolder}/" is a profile \u2014 pick which one runs.`,
        visible: () => nativeSecretStorageAvailable() || this.plugin.settings.agentSectionUnlocked,
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
        visible: () => nativeSecretStorageAvailable() || this.plugin.settings.agentSectionUnlocked,
        control: { type: 'text', key: 'agent.agentsFolder' },
      },
      {
        name: 'Reports folder',
        desc:
          'Vault-relative. Where the agent writes AI-authored report notes (e.g. a continuity report spanning ' +
          'the whole text) — separate from the agent profiles folder above, which holds instructions, not output.',
        visible: () => nativeSecretStorageAvailable() || this.plugin.settings.agentSectionUnlocked,
        control: { type: 'text', key: 'agent.reportsFolder' },
      },
      {
        name: 'Scope',
        desc: 'Run on your current selection, the whole active file, or every file that currently gets margin notes.',
        visible: () => nativeSecretStorageAvailable() || this.plugin.settings.agentSectionUnlocked,
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
        visible: () => nativeSecretStorageAvailable() || this.plugin.settings.agentSectionUnlocked,
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
      case 'narrowPaneCutoffPx':
        return s.narrowPaneCutoffPx;
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
          // Not reached in practice — the API-key row uses its own manual
          // `render:` (see getSettingDefinitions above), not `control:`,
          // the same as before this migration. Kept for type-safety/
          // consistency with the read path this key namespace implies.
          const secretField = key.slice('secrets.'.length) as keyof SecretSettings;
          return this.readSecret(secretField);
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
      case 'narrowPaneCutoffPx':
        s.narrowPaneCutoffPx = value as number;
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
          // Not reached in practice — the Model row now uses its own
          // manual `render:` (see getSettingDefinitions above), not
          // `control:`, so this dispatcher key is never actually
          // constructed. Routed through commitModelToHistory anyway for
          // consistency, so history stays in sync if that ever changes.
          const provider = key.slice('agent.modelByProvider.'.length) as AgentProvider;
          await this.commitModelToHistory(provider, value as string);
          return;
        }
        if (key.startsWith('secrets.')) {
          // Not reached in practice — see the matching comment in
          // getControlValue above.
          const secretField = key.slice('secrets.'.length) as keyof SecretSettings;
          await this.writeSecret(secretField, (value as string).trim());
          return;
        }
        throw new Error(`MarginNotesSettingTab.setControlValue: unrecognized key "${key}"`);
    }
  }
}