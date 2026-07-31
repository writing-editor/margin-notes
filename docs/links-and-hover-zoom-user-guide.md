# Margin Notes — Links, Embeds & Hover-Zoom: user guide

This covers the two features added on top of the base `[mn: ...]` margin
notes: **links/embeds previewed in the margin**, and **hover-zoom** on every
margin chip. For the original note-taking feature, see the main README.

## Writing a link or embed

Just write normal Obsidian wikilink syntax anywhere in a file with margin
notes turned on:

| You type | What shows in the text | What shows in the margin |
|---|---|---|
| `[[Character Bible]]` | Character Bible (plain, underlined text) | a **link** chip, live preview |
| `[[Character Bible\|Alice]]` | Alice (plain, underlined text) | a **link** chip, live preview |
| `[[Character Bible#Alice]]` | Character Bible | same, jumps to that heading on click |
| `[[Character Bible#Alice\|Alice's Heading]]` | Alice's Heading | same |
| `![[Character Bible]]` | *Obsidian's own inline embed* — the note's content appears embedded right in the text, same as it always does | an **embed** chip, live preview |
| `![[Character Bible#Alice]]` | same, scoped to that heading | same, scoped to that heading |

Notes:
- `[[links]]` render as clean plain text — no brackets, underlined in a
  muted accent color so it still reads as a link, just not shouting-blue
  like Obsidian's default.
- `![[embeds]]` are left alone in the main text — Obsidian already renders
  these as an inline embedded block natively, and this plugin doesn't
  change that. What this plugin *adds* for embeds is the margin chip
  preview next to them; the inline behavior in the text itself is
  unchanged, ordinary Obsidian.
- Click the text (or the margin chip) to jump to that note. If the note
  doesn't exist yet, Obsidian will offer to create it — same as clicking
  any normal `[[link]]` in Obsidian.
- Put your cursor inside a `[[...]]` and it reveals the raw brackets/syntax
  so you can edit it — moving the cursor away collapses it back to plain
  text. (This reveal-on-cursor behavior is specific to `[[links]]`; `![[embeds]]`
  follow Obsidian's own normal reveal-on-cursor behavior for embeds.)

## Reading the margin chip

Each chip has a small label in the top-left corner:

- **`link`** — from a `[[...]]` reference.
- **`embed`** — from a `![[...]]` reference.
- A colored left edge distinguishes the two at a glance (and both are a
  different color from ordinary `mn:` note chips).

The chip's body shows a live preview of the target note's actual content,
rendered the same way Obsidian renders any note. Three possible states:

1. **Loading** — briefly dimmed, shows just the title while the preview
   loads. Normal and expected for a fraction of a second after the file
   opens or scrolls into view.
2. **Loaded** — full rendered preview: headings, paragraphs, quotes, lists,
   whatever the target note contains.
3. **Not found** — if the target note doesn't exist, the chip shows a
   dashed border and muted italic text: `No note titled "..." yet`. This
   is not an error — it just means nothing to preview yet. Clicking it will
   offer to create the note.

If you edit the target note elsewhere while its chip is visible, the chip's
preview updates on its own the next time you save that note — no need to
reopen or manually refresh the file with the chip in it.

## Hover-zoom

Hover your mouse over **any** margin chip — a note, a link, or an embed —
and it grows slightly and lifts with a soft shadow, showing its full
content even if it was too tall to fit in its normal spot. Move the mouse
away and it settles back.

- This is purely visual — it never moves your cursor, changes your
  selection, or does anything to the document itself.
- It works the same whether the chip was already showing everything or was
  cut off ("clamped") for lack of room — even a chip with nothing extra to
  reveal still gets the same little lift, just for visual consistency.
- The zoomed chip always grows toward the margin, never toward your text.
  It won't cover your writing.

## Tips

- If several notes/links land close together on the page, the margin
  automatically shrinks whichever chips don't have room, fading their
  bottom edge to hint there's more — hover any of them to see the rest.
- Links and notes interleave correctly: a `[mn: ...]` note and a `[[link]]`
  near each other on the page are laid out together, not independently, so
  they won't overlap.
- Nothing about this changes how `[mn: ...]` notes themselves work — this
  is purely additive.

---

*A future version may turn this into buttons/menu commands (e.g. "Insert
link" the same way "Insert margin note" already exists) rather than typing
raw `[[...]]`/`![[...]]` syntax by hand — not implemented yet.*