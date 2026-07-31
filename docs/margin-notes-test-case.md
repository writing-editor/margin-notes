---
margin-notes: true
---
---

## margin-notes: true

# Margin Notes — feature test case (v2)

Put this file (and `Character Bible.md`, alongside it) anywhere your `margin-notes` trigger rule covers — the frontmatter above already sets `margin-notes: true` directly, so it should light up regardless of your folder/frontmatter-key setting. See the checklist at the very bottom for what to actually look for at each numbered section.

**What changed since the last version of this test file:** Obsidian-style embeds (double-bracket references prefixed with an exclamation mark) are no longer touched by this plugin at all — Obsidian renders those entirely on its own now, with no margin chip. This file no longer tests embeds. It adds two new sections that specifically target real bugs found in the previous round: several double-bracket links pointing at the SAME note (the "preview sometimes shows, sometimes doesn't" bug), and a link written inside a margin note's own text (which used to truncate the note).

**A note on this file itself:** everywhere below that needs to actually _demonstrate_ the syntax uses real, working links and notes — but the explanatory prose describing them (like this paragraph) intentionally avoids writing out literal double-bracket or `[mn` syntax, because this plugin parses that syntax wherever it appears in the document, including inside a sentence that's only _talking about_ the syntax. Writing example syntax directly in a heading or description would create extra, unintended chips.

## 1. Basic `mn:` notes, a few types

Lorem ipsum dolor sit amet, consectetur adipiscing elit.[mn: A bare, default-type note. Should render as a small superscript "1", accent-colored per the default type.] Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.

Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.[mn.warning: A warning-type note — should be a distinctly different accent color from the default note above.] Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore.

Excepteur sint occaecat cupidatat non proident.[mn.todo: A todo-type note, its own accent color again.] Sunt in culpa qui officia deserunt mollit anim id est laborum.

## 2. Double-bracket links — all four grammar forms

Test each of these individually resolves and renders correctly:

Curabitur pretium tincidunt lacus.[[Character Bible]] Nulla gravida orci a odio.

Aliquam ac quam sit amet nunc.[[Character Bible|Alice]] Etiam auctor ipsum et nibh.

Vivamus at nunc ac velit.[[Character Bible#Alice]] Praesent volutpat eros non.

Nunc viverra imperdiet enim.[[Character Bible#Alice|Alice's Heading]] Sed fringilla mauris sit amet nibh.

## 3. Same target linked multiple times — the "sometimes no preview" bug

This is the important regression test. All four links below point at the SAME note. Before the fix, only the last one processed would keep its rendered preview — every earlier one would silently lose its content and show just the "link" label with the bare title, because the previews used to share one DOM node that could only live in one chip at a time.

First mention here.[[Character Bible]] Second mention right after.[[Character Bible]] Third mention, still close together.[[Character Bible]] Fourth and last mention in this cluster.[[Character Bible]]

All four chips should show a full rendered preview — none of them should be stuck showing just the bare title with no content.

## 4. A link written INSIDE a note — the note-truncation bug

Before the fix, `MN_RE` would stop at the link's own closing bracket instead of the note's real one, truncating the note and leaving stray bracket characters visible as broken text.

Donec ullamcorper nulla non metus.[mn: This note mentions [[Character Bible]] right in the middle of its own text, and should NOT be truncated — you should see this full sentence, including the words "right in the middle of its own text", as the note's content when you click into it or hover it.] Auctor fringilla vestibulum id ligula.

The nested link inside that note should NOT get its own separate margin chip or its own separate clickable inline styling — it's part of the note's own content now, same as any other text inside a margin note. If you click into the note to edit it (click its superscript chip), you'll see the raw double-bracket text right there as part of what you're editing.

## 5. Broken link — the "note not found" state

Duis mollis, est non commodo luctus.[[This Note Definitely Does Not Exist]] Neque nisi consectetur nisi.

## 6. Dense paragraph — clamping + collision-avoidance stress test

Donec ullamcorper nulla non metus auctor fringilla.[mn: First note in a tight cluster — everything in this section sits close together on purpose.] Vestibulum id ligula porta felis euismod semper.[mn.danger: Second note, right after the first — this and its neighbors should test the two-pass clamp/collision logic together.] Fusce dapibus tellus ac cursus commodo.[[Character Bible|Alice]] Nulla vitae elit libero a pharetra augue.[mn.example: Third note, immediately after a link chip — confirms note and link chips clamp sensibly as neighbors, not just against their own kind.] Donec ullamcorper nulla non metus auctor fringilla.[[Character Bible]] Cras mattis consectetur purus sit amet fermentum.[mn.info: Fourth and last note in the cluster.]

## 7. An isolated note, far from any neighbor (should never clamp)

Lorem ipsum dolor sit amet.

Consectetur adipiscing elit sed do eiusmod.

Tempor incididunt ut labore et dolore magna aliqua.[mn.success: This one has plenty of room below it and above it — should NEVER show a clamp/fade, and on hover should still get the same scale + shadow lift as every other chip, just with nothing extra to reveal.]

Ut enim ad minim veniam quis nostrud.

Exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.

---

## What to check against each section

**Section 1 — `mn:` notes**

- Each superscript number appears inline, colored per its type (default vs warning vs todo — three visibly different accent colors).
- Clicking a chip moves the caret into that note's own text in the document and selects it (ready to retype).
- Hovering each chip: scales up (~1.12x), soft shadow appears, no hard border, grows toward the left (never toward the main text column).

**Section 2 — double-bracket link forms**

- All four render as plain text with a subtle underline (muted accent color, not Obsidian's default blue) — no brackets, no `!`.
- The plain-target form shows "Character Bible"; the piped-alias form shows "Alice"; the heading forms show whichever text precedes the pipe per the alias rule (the heading itself is not shown inline — only affects navigation).
- Clicking any of them opens `Character Bible.md` (the `#heading` ones should additionally jump to that heading if Obsidian resolves it).
- Each has a margin chip labeled "link".
- The chip should show a loading/dimmed title-only state very briefly, then swap to the actual rendered preview of `Character Bible.md`'s content.

**Section 3 — same target, multiple times (regression test)**

- **All four chips must show full rendered content.** If any of them is stuck showing just "link" + the bare title with no preview text below it, the bug has regressed — check the console for errors and see linkPreview.ts's cache comment.
- Try this at different scroll positions / after resizing the window, a few times — the original bug was intermittent and order-dependent, so a single clean pass isn't fully conclusive on its own.

**Section 4 — link nested inside a note**

- The note's superscript chip, when clicked/hovered, must show its FULL content, including the words after the nested link — not truncated at the link.
- The double-bracket text inside that note should NOT appear as its own separate underlined/clickable span, and should NOT get its own separate margin chip — it's swallowed into the note as plain text.

**Section 5 — broken link**

- Inline text still renders plainly (just "This Note Definitely Does Not Exist" as underlined text, clickable).
- Clicking it should offer to create the note (standard Obsidian behavior via `openLinkText`).
- The margin chip must NOT be blank and must NOT throw a console error — expect a dashed left border, muted/italic text reading something like `No note titled "This Note Definitely Does Not Exist" yet`.
- If you then actually create that note (click it, save the new empty file, come back to this file), the chip should self-correct to a real preview on the next natural re-render — it should NOT be permanently stuck saying "not found."

**Section 6 — dense cluster**

- None of the chips should visually overlap at rest. Some should show the clamped fade-out (mask) if content doesn't fit in the room before the next chip's real anchor.
- Confirm a clamped chip, on hover, expands to full content while still respecting the "don't drift toward the text" rule.

**Section 7 — isolated note**

- Should render completely unclamped at rest (full text visible, no mask/fade).
- On hover it should STILL get the scale+shadow treatment.

**Narrow-pane / mobile (if you can test it)**

- Split this pane into two side-by-side notes (right-click the tab → Split right, or drag the tab) so this file's pane gets narrower. Below the "Hide chips in narrow panes" threshold in settings (700px by default), the margin chip column should disappear entirely and the prose should regain the full pane width — but superscript note numbers and underlined link text should keep working exactly as before, just without chips.
- On Obsidian Mobile (phone), chips should be off by default ("Hide chips on mobile" setting) — again, superscripts and underlined links should still work normally.

**General / whole-file**

- Scroll up and down the whole file several times, then re-check hover still works correctly and no chip has drifted from its anchor line.
- Edit `Character Bible.md` directly (add a line, save) while this file's tab is still open and its link chips are visible — their preview content should update live without you needing to touch this file.
- Open your browser/Obsidian dev console (Ctrl+Shift+I) while doing all of the above — there should be zero uncaught errors at any point.