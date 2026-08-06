# Margin Notes — Links & Hover-Zoom: user guide

This covers two things that work alongside the base `[mn: ...]` margin
notes feature: **`[[links]]`**, and **hover-zoom** on margin note chips.
For the original note-taking feature, see the main README.

## Writing a link

Just write a normal Obsidian wikilink anywhere in a file with margin notes
turned on:

| You type | What shows in the text |
|---|---|
| `[[Character Bible]]` | Character Bible (plain, underlined text) |
| `[[Character Bible\|Alice]]` | Alice (plain, underlined text) |
| `[[Character Bible#Alice]]` | Character Bible, jumps to that heading on click |
| `[[Character Bible#Alice\|Alice's Heading]]` | Alice's Heading |

Notes:
- Links render as clean plain text — no brackets — underlined in a muted
  accent color so it still reads as a link, just not shouting-blue like
  Obsidian's default.
- **Clicking a link opens the target note in a new tab**, rather than
  replacing the note you're currently reading — so you never lose your
  place in the document you're annotating. If the note doesn't exist yet,
  Obsidian will offer to create it, same as clicking any normal
  `[[link]]` in Obsidian.
- Put your cursor inside a `[[...]]` and it reveals the raw brackets/syntax
  so you can edit it — moving the cursor away collapses it back to plain
  text.
- **A `[[link]]` written inside an `[mn: ...]` note's own text is treated
  as part of that note**, not as a separate link. It won't get its own
  underline — it stays as ordinary text within the note, and you can
  see/edit the raw `[[...]]` by clicking into the note the normal way.
  This keeps a note's content from being silently cut off partway through
  if you happen to reference another note inside it.

The AI notes agent can also place links for you: when it produces a
longer, report-style finding, it writes that report out to its own file
and drops a plain `[[link]]` to it right in your document, same syntax as
if you'd typed it yourself.

## Hover-zoom

Hover your mouse over any `[mn: ...]` margin note chip and it grows
slightly and lifts with a soft shadow, showing its full content even if
it was too tall to fit in its normal spot. Move the mouse away and it
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

**Important: underlined link text keeps working exactly as normal in both
of these cases.** Only the note-chip column itself — the thing that needs
the extra horizontal space — hides. You don't lose the ability to see or
click through to a link; that's plain inline text with no layout cost, so
it's unaffected either way.

## Tips

- If several `[mn: ...]` notes land close together on the page, the
  margin automatically shrinks whichever chips don't have room, fading
  their bottom edge to hint there's more — hover any of them to see the
  rest.
- Links don't take up margin space at all, so they never compete with
  note chips for room — only `[mn: ...]` notes are laid out in the
  margin.
- Nothing about links changes how `[mn: ...]` notes themselves work —
  the two are independent.

---

*A future version may turn link insertion into a button/menu command (the
same way "Insert margin note" already exists) rather than typing raw
`[[...]]` syntax by hand — not implemented yet.*
