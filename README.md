# Margin Notes

Literal book-margin notes for Obsidian — jot a quick note next to any
paragraph, the same way you'd scribble in the margin of a physical book.
Turn it on per file, per folder, or vault-wide. Comes with an optional AI
notes agent that can suggest and place notes for you.

![Margin Notes in action](docs/screenshot.png)

## Getting started

1. Settings → Community plugins → enable "Margin Notes".
2. Turn margin notes on for a file: add `margin-notes: true` to that
   file's frontmatter (or set a folder rule / "every file" in the plugin's
   settings, if you'd rather not add it per file).
3. Run **Insert margin note** (Cmd/Ctrl+P) with your cursor in a
   paragraph, or type `[mn.` to pick a note type as you write.
4. That's it — the note shows as a small superscript marker inline, with
   its full content in a chip in the margin.

### Writing a note directly

You can also just type the syntax yourself instead of using the command:

| You type | What you get |
|---|---|
| `[mn: a quick note]` | a plain margin note |
| `[mn.question: why does this happen?]` | a note tagged with a type (color-coded in the margin) |

### Links in the margin

A normal `[[wikilink]]` in a file with margin notes turned on gets a
margin chip too — a live preview of the linked note's content, updated
automatically if that note changes. See the
[full links & hover-zoom guide](docs/links-and-hover-zoom-user-guide.md)
for the details (aliases, headings, hover-zoom, etc).

## The AI notes agent (optional)

Beyond writing notes yourself, you can ask an AI agent to read a file (or
your whole vault) and suggest notes for you — continuity issues, line
edits, or whatever a custom agent profile asks it to look for. It's
entirely opt-in: nothing runs until you explicitly trigger it.

Set it up in Settings → Margin Notes:
- Pick a provider (Claude, OpenAI, Gemini, or a local Ollama instance) and
  add your API key, or point at Ollama for a fully local setup.
- Pick an agent profile — two are bundled (continuity checker, line
  editor), or drop your own markdown file into the configured agents
  folder to define more.
- Pick a scope: current selection, current file, or the whole vault.
- Run it from the command palette or the settings-tab button.

Every AI-suggested note is clearly marked (`[mn.ai: ...]`) and never edits
your existing prose — it only adds notes alongside it.

### Network use

The core margin-notes feature (writing `[mn: ...]` and `[[link]]` markers
yourself) makes no network calls at all. The AI agent above is the only
feature that does:

- **What's sent:** the text of the current file, the current selection, or
  every enabled file in the vault — whichever scope you pick — plus your
  chosen agent profile's instructions. Nothing else (no telemetry, no
  usage analytics, no vault metadata beyond that text).
- **Where it's sent:** whichever provider you configure and give an API
  key to — Anthropic (Claude), OpenAI, or Google (Gemini) — or a locally
  running Ollama instance you point at yourself, in which case nothing
  leaves your machine. You choose the provider; nothing is contacted by
  default.
- **When it's sent:** only when you explicitly run the agent — never
  automatically, never on a timer, never on file open/save.
- **API keys:** stored in their own file, `api-keys.json`, next to (not
  inside) this plugin's normal `data.json` — both live in
  `.obsidian/plugins/margin-notes/`. This is deliberate: it means you can
  gitignore just the one file with the keys in it, without also
  gitignoring every other setting (spelling convention, density, agent
  profile, margin width, etc.), which living in the shared `data.json`
  would otherwise force. Keys are encrypted through your OS keychain
  before being written there when that's genuinely available on your
  platform/session; when it isn't, they're stored in plain text in that
  same file, and the settings tab says so plainly rather than claiming
  otherwise.
  - **If your vault is a git repository:** add
    `.obsidian/plugins/margin-notes/api-keys.json` to your `.gitignore`
    — Obsidian does not gitignore anything for you by default. Only that
    one file needs to be ignored; `data.json` and the rest of the plugin
    can stay tracked normally.
  - **If you use Obsidian Sync:** Obsidian's own docs say the vault's
    `.obsidian` config folder syncs even though hidden folders are
    normally excluded — but the specific option that carries per-plugin
    settings, "Installed/Active community plugin list," is **off by
    default** and has to be turned on deliberately. Since the whole
    plugin folder syncs as a unit when that option is on, `api-keys.json`
    goes along with it — the file split above doesn't change this, it
    only changes what a *git* ignore rule needs to cover.
  - **If you use a generic file-sync tool instead** (Dropbox, Syncthing,
    iCloud, a synced folder, etc.): these have no concept of "plugin
    settings" as a separate category — they sync `.obsidian` and
    everything in it, `api-keys.json` included, the same as any other
    file, with no toggle to exclude it.
  - Either way, if your key is only obscured with `plain:` (see above),
    a sync path that includes this file sends the plaintext key
    wherever that sync goes, not just between your own devices. Even a
    genuinely OS-keychain-encrypted key (`enc:`) is encrypted for the
    machine that made it — Electron's `safeStorage` is machine-bound, so
    a synced copy typically just fails to decrypt on a different device
    rather than transferring usefully. Either way, re-enter the key
    per-device rather than relying on sync to carry it, and check your
    sync service's own settings for whether community-plugin data is
    included before assuming it isn't.

## Installing (no build needed)

1. Create `<your-vault>/.obsidian/plugins/margin-notes/` (`.obsidian` is
   the default name for a vault's config folder — if yours was renamed,
   use that folder instead).
2. Copy `manifest.json`, `main.js`, and `styles.css` into that folder.
3. In Obsidian: Settings → Community plugins → reload, then enable "Margin Notes".

## Known caveats

- **Selection scope needs a live editor** — running the AI agent on just
  your current selection only works on the file you currently have open,
  not when scope is set to "vault."

## More

- Building from source, how the plugin is put together internally, and
  ideas being considered for the future all live in
  [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) — useful if you're
  modifying the plugin or just curious, not needed to use it.