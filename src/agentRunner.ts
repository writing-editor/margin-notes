import { App, MarkdownView, Notice, TFile } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { AGENT_PROVIDERS, Placement, PromptOptions, loadAgentPrompt, runAgentChat, spliceIntoRawText, verifyInsertOnly } from './agents';
import { insertAiNotes } from './marginPanel';
import { decryptSecret } from './secureStorage';
import { isMarginNotesEnabled } from './runtime';
import type { MarginNotesSettings } from './settings';

function getCM6View(app: App, file: TFile): EditorView | undefined {
  const leaf = app.workspace.getLeavesOfType('markdown').find((l) => (l.view as MarkdownView).file === file);
  const view = leaf?.view as MarkdownView | undefined;
  return (view?.editor as unknown as { cm?: EditorView } | undefined)?.cm;
}

function providerConfig(settings: MarginNotesSettings) {
  const providerMeta = AGENT_PROVIDERS.find((p) => p.id === settings.agent.provider)!;
  return {
    provider: settings.agent.provider,
    model: settings.agent.modelByProvider[settings.agent.provider],
    apiKey: decryptSecret(settings.secrets[providerMeta.secretField]),
    ollamaUrl: settings.agent.ollamaUrl,
  };
}

// Plan §2.5 — the two global prompt settings, read fresh each run so a
// change in the settings tab takes effect on the very next "Run agent
// now" without needing a reload.
function promptOptions(settings: MarginNotesSettings): PromptOptions {
  return { spelling: settings.spelling, density: settings.density };
}

/** Whole-file run: text comes from the live editor if the file is open, otherwise the Vault API. */
async function runOnFile(app: App, settings: MarginNotesSettings, file: TFile, agentPrompt: string): Promise<{ added: number; rejected: number; capped: number }> {
  const cmView = getCM6View(app, file);
  const before = cmView ? cmView.state.doc.toString() : await app.vault.read(file);

  const { placements, rejected, capped } = await runAgentChat(providerConfig(settings), agentPrompt, before, promptOptions(settings));
  if (placements.length === 0) return { added: 0, rejected, capped };

  if (cmView) {
    insertAiNotes(cmView, placements);
    if (!verifyInsertOnly(before, cmView.state.doc.toString())) {
      new Notice(`Margin Notes: insert-only check failed for ${file.basename} — please review (undo with Cmd/Ctrl+Z if needed).`);
    }
  } else {
    const after = spliceIntoRawText(before, placements);
    if (!verifyInsertOnly(before, after)) throw new Error(`insert-only check failed for ${file.basename} — aborting write.`);
    await app.vault.process(file, () => after);
  }
  return { added: placements.length, rejected, capped };
}

/** Selection run: only the selected substring is sent to the model; returned positions are shifted back into the full document before inserting. */
async function runOnSelection(app: App, settings: MarginNotesSettings, file: TFile, agentPrompt: string): Promise<{ added: number; rejected: number; capped: number }> {
  const cmView = getCM6View(app, file);
  if (!cmView) throw new Error('No open editor for the active file — selection scope needs a live editor.');

  const sel = cmView.state.selection.main;
  if (sel.from === sel.to) throw new Error('Nothing selected — select some text first, or switch scope to "Current file".');

  const before = cmView.state.doc.toString();
  const selectedText = before.slice(sel.from, sel.to);

  const { placements, rejected, capped } = await runAgentChat(providerConfig(settings), agentPrompt, selectedText, promptOptions(settings));
  if (placements.length === 0) return { added: 0, rejected, capped };

  // Shift every placement from "offset into the selected substring" to
  // "offset into the real document" before it ever reaches insertAiNotes.
  const shifted: Placement[] = placements.map((p) => ({ charPos: p.charPos + sel.from, content: p.content }));

  insertAiNotes(cmView, shifted);
  if (!verifyInsertOnly(before, cmView.state.doc.toString())) {
    new Notice(`Margin Notes: insert-only check failed for ${file.basename} — please review (undo with Cmd/Ctrl+Z if needed).`);
  }
  return { added: shifted.length, rejected, capped };
}

export async function runAgent(app: App, settings: MarginNotesSettings, activeFile: TFile | null): Promise<void> {
  const agentName = settings.agent.selectedAgent;
  const agentPrompt = await loadAgentPrompt(app, settings.agent.agentsFolder, agentName);

  if (settings.agent.scope !== 'vault' && (!activeFile || !isMarginNotesEnabled(activeFile))) {
    new Notice('Margin notes are not enabled for the current file — see plugin settings.');
    return;
  }

  const targets: TFile[] =
    settings.agent.scope === 'vault' ? app.vault.getMarkdownFiles().filter((f) => isMarginNotesEnabled(f)) : activeFile ? [activeFile] : [];

  if (targets.length === 0) {
    new Notice('Margin Notes: no files to run the agent on.');
    return;
  }

  const notice = new Notice(`Margin Notes: running "${agentName}" on ${targets.length} file${targets.length > 1 ? 's' : ''}…`, 0);
  let totalAdded = 0;
  let totalRejected = 0;
  let totalCapped = 0;
  let failures = 0;

  for (const file of targets) {
    try {
      const result =
        settings.agent.scope === 'selection' ? await runOnSelection(app, settings, file, agentPrompt) : await runOnFile(app, settings, file, agentPrompt);
      totalAdded += result.added;
      totalRejected += result.rejected;
      totalCapped += result.capped;
    } catch (err) {
      failures++;
      console.error('Margin Notes agent run failed for', file.path, err);
      if (settings.agent.scope !== 'vault') {
        notice.hide();
        new Notice(`Margin Notes: ${(err as Error).message ?? err}`);
        return;
      }
    }
  }

  notice.hide();
  const parts = [`added ${totalAdded} note${totalAdded === 1 ? '' : 's'}`];
  if (totalRejected) parts.push(`rejected ${totalRejected}`);
  if (totalCapped) parts.push(`capped ${totalCapped} for density`);
  if (failures) parts.push(`${failures} file${failures === 1 ? '' : 's'} failed`);
  new Notice(`Margin Notes: ${parts.join(', ')}.`);
}