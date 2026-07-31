# Margin Notes — Links & Hover-Zoom: user guide

This covers the two features added on top of the base `[mn: ...]` margin
notes: **`[[links]]` previewed in the margin**, and **hover-zoom** on every
margin chip. For the original note-taking feature, see the main README.

`![[embeds]]` are NOT part of this — this plugin leaves embeds entirely to
Obsidian's own built-in rendering. See "Why not embeds?" at the bottom if
you're curious why.

## Writing a link

Just write a normal Obsidian wikilink anywhere in a file with margin notes
turned on:

| You type | What shows in the text | What shows in the margin |
|---|---|---|
| `[[Character Bible]]` | Character Bible (plain, underlined text) | a **link** chip, live preview |
| `[[Character Bible\|Alice]]` | Alice (plain, underlined text) | a **link** chip, live preview |
| `[[Character Bible#Alice]]` | Character Bible | same, jumps to that heading on click |
| `[[Character Bible#Alice\|Alice's Heading]]` | Alice's Heading | same |

Notes:
- Links render as clean plain text — no brackets — underlined in a muted
  accent color so it still reads as a link, just not shouting-blue like
  Obsidian's default.
- Click the text (or the margin chip) to jump to that note. If the note
  doesn't exist yet, Obsidian will offer to create it — same as clicking
  any normal `[[link]]` in Obsidian.
- Put your cursor inside a `[[...]]` and it reveals the raw brackets/syntax
  so you can edit it — moving the cursor away collapses it back to plain
  text.
- **A `[[link]]` written inside an `[mn: ...]` note's own text is treated
  as part of that note**, not as a separate link. It won't get its own
  underline or its own margin chip — it stays as ordinary text within the
  note, and you can see/edit the raw `[[...]]` by clicking into the note
  the normal way. This keeps a note's content from being silently cut off
  partway through if you happen to reference another note inside it.

## Reading the margin chip

Each link chip has a small `link` label in the top-left corner, with a
colored left edge distinguishing it from `mn:` note chips.

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
   offer to create the note. If you then create that note, the chip
   corrects itself to a real preview automatically.

If you edit the target note elsewhere while its chip is visible, the chip's
preview updates on its own the next time you save that note — no need to
reopen or manually refresh the file with the chip in it. This also works
correctly when the SAME note is linked from several places in one
document — every chip pointing at it gets its own independent, correctly
updating preview.

## Hover-zoom

Hover your mouse over **any** margin chip — a note or a link — and it
grows slightly and lifts with a soft shadow, showing its full content even
if it was too tall to fit in its normal spot. Move the mouse away and it
settles back.

- This is purely visual — it never moves your cursor, changes your
  selection, or does anything to the document itself.
- It works the same whether the chip was already showing everything or was
  cut off ("clamped") for lack of room — even a chip with nothing extra to
  reveal still gets the same little lift, just for visual consistency.
- The zoomed chip always grows toward the margin, never toward your text.
  It won't cover your writing.

## Narrow panes and mobile

The margin chip column needs some real horizontal room to be useful. When
there isn't enough:

- **Split panes.** If you split your editor into two (or more) notes side
  by side, whichever pane gets too narrow automatically hides its chip
  column and gives that space back to your prose. This is controlled by a
  ratio in settings ("Hide chips in narrow panes," 3.0x by default) rather
  than a fixed size — chips hide once the pane gets narrower than that many
  times your margin width, so it automatically stays sensible even if you
  change the margin width elsewhere in settings. Set it to 0 to always show
  chips no matter how narrow the pane gets.
- **Mobile.** On Obsidian Mobile (phones — tablets are unaffected and keep
  the normal desktop-style layout), chips are off by default. There's a
  toggle for this in settings ("Hide chips on mobile") if you'd rather keep
  them on.

**Important: superscript note numbers and underlined link text keep
working exactly as normal in both of these cases.** Only the chip column
itself — the thing that needs the extra horizontal space — hides. You
don't lose the ability to see which sentences have notes/links, or to
click through to them; you just don't get the live margin preview until
there's room for it again.

## Tips

- If several notes/links land close together on the page, the margin
  automatically shrinks whichever chips don't have room, fading their
  bottom edge to hint there's more — hover any of them to see the rest.
- Links and notes interleave correctly: a `[mn: ...]` note and a `[[link]]`
  near each other on the page are laid out together, not independently, so
  they won't overlap.
- Nothing about this changes how `[mn: ...]` notes themselves work — this
  is purely additive.

## Why not embeds?

An earlier version of this feature also tried to give `![[embeds]]` the
same treatment (margin chip + preview). It was removed: Obsidian already
renders `![[...]]` as a live embedded block right in the text where you
write it — that already IS a live preview, in place. Adding a second,
separate preview in the margin on top of that just meant seeing the same
content twice for no real benefit, plus it fought with Obsidian's own
rendering internally in ways that caused inconsistent bugs. Links don't
have that overlap — Obsidian leaves `[[links]]` as plain clickable text
with no inline preview at all, which is exactly the gap this plugin's
margin chip fills. So links get full treatment; embeds are left entirely
to Obsidian, unmodified.

---

*A future version may turn link insertion into a button/menu command (the
same way "Insert margin note" already exists) rather than typing raw
`[[...]]` syntax by hand — not implemented yet.*