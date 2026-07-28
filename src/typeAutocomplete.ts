import { autocompletion, Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { editorInfoField } from 'obsidian';
import { isMarginNotesEnabled } from './runtime';
import { NOTE_TYPES } from './noteTypes';

// Triggered by typing "[mn." — offers every registered note type (see
// noteTypes.ts, the single place types are defined) with a colour swatch
// matching the marker/chip colour it'll get. Picking one inserts
// "[mn.<id>: " and leaves the cursor ready for content; the closing "]" is
// left for the person to type (or for whatever bracket-closing behaviour
// Obsidian's editor already has) rather than guessed here.
//
// The bare/default type ('') is intentionally excluded — there's no dot to
// autocomplete for `[mn: ...]`, you just don't type a type.
function mnTypeCompletions(context: CompletionContext): CompletionResult | null {
  const info = context.state.field(editorInfoField, false);
  if (!isMarginNotesEnabled(info?.file ?? null)) return null;

  const match = context.matchBefore(/\[mn\.\w*/);
  if (!match) return null;
  if (match.from === match.to && !context.explicit) return null;

  const typed = match.text.slice('[mn.'.length).toLowerCase();
  const options: Completion[] = NOTE_TYPES.filter((t) => t.id && t.id.startsWith(typed)).map((t) => ({
    label: t.id,
    detail: t.label,
    apply: `[mn.${t.id}: `,
    render: (el: HTMLElement) => {
      const swatch = document.createElement('span');
      Object.assign(swatch.style, {
        display: 'inline-block',
        width: '8px',
        height: '8px',
        marginRight: '6px',
        borderRadius: '2px',
        background: t.color,
      });
      el.appendChild(swatch);
      el.appendChild(document.createTextNode(t.label));
    },
  }));

  if (!options.length) return null;

  return { from: match.from, to: match.to, options, filter: false };
}

// NOTE: Obsidian's own editor already runs its own autocompletion config
// (wikilinks, tags, slash-command style suggesters some plugins add, etc).
// @codemirror/autocomplete's `autocompletion()` config facet is combinable —
// multiple calls merge rather than one replacing the other — but this is
// exactly the kind of Obsidian-internal behaviour this project's README
// already flags as "not officially typed/guaranteed" for editor.cm. If a
// future Obsidian version changes how it wires its own autocompletion,
// verify this still shows up alongside (not instead of) Obsidian's own
// suggestions.
export const mnTypeAutocomplete = autocompletion({ override: [mnTypeCompletions] });
