import { Platform } from 'obsidian';

// Obsidian plugins run with full Node/Electron access on desktop (no
// sandboxing), so requiring Electron's safeStorage directly — the same
// module the original app's electron/ai-keystore.js wraps — works here
// too, IN PRINCIPLE. In practice this has proven fragile in ways worth
// spelling out, because every one of them silently degrades to plaintext
// rather than throwing, which is exactly the failure mode a person
// storing an API key needs to be told about rather than have hidden:
//
// 1. Obsidian's desktop app is Electron, but a plugin runs in the
//    RENDERER process with only "a limited emulation of node APIs"
//    (Obsidian's own docs) — `safeStorage` is a module Electron
//    documents as living on the object require('electron') returns, but
//    plugin authors have reported it simply not being present at
//    runtime in Obsidian's renderer context (see e.g. the Obsidian forum
//    thread "Electron safeStorage available?"). require('electron')
//    itself won't throw in that case; `.safeStorage` on the result is
//    just `undefined`, or present as an object missing the methods this
//    file needs.
// 2. On Linux, `isEncryptionAvailable()` can return `true` even when
//    there's no real OS secret store available (no keyring/kwallet
//    running) — Electron's own docs say it then falls back to "a
//    hardcoded plaintext password," so a value "encrypted" in that state
//    isn't meaningfully protected, even though the naive availability
//    check says yes. Electron exposes `getSelectedStorageBackend()` to
//    tell these apart (`'basic_text'` = the unprotected fallback); this
//    file treats that case as encryption NOT available rather than
//    trusting `isEncryptionAvailable()` alone.
// 3. On Windows/macOS, `isEncryptionAvailable()` has been reported to
//    return incorrect results if called before Electron's `app` module
//    has emitted its `ready` event — not really reachable from a plugin
//    (Obsidian itself is already running by the time a plugin loads),
//    but worth knowing about if this ever moves earlier in the load
//    sequence.
//
// None of this means "give up and always store plaintext" — safeStorage
// genuinely does work on a normal, fully set up desktop install, this
// file just needs to (a) verify the SHAPE of what it got back before
// trusting it, not just truthiness of the top-level object, (b) tell the
// difference between "really encrypted" and "Electron's own unprotected
// fallback," and (c) say clearly which of these is happening in the
// settings tab, rather than a single generic "no OS keychain" message
// that reads the same whether the real cause is "you're on a barebones
// Linux install" or "Obsidian didn't expose this API at all this
// session."
interface SafeStorageLike {
  isEncryptionAvailable: () => boolean;
  encryptString: (plainText: string) => Buffer;
  decryptString: (encrypted: Buffer) => string;
  // Present on newer Electron; absent on older versions. Optional so this
  // interface still matches what an older Electron actually provides —
  // its absence is handled explicitly below, not assumed to mean broken.
  getSelectedStorageBackend?: () => string;
}

// Distinguishes WHY encryption isn't available, so secretStorageDescription()
// can say something more useful than one generic line for every cause.
type AvailabilityReason =
  | 'available' // genuinely encrypted, real OS-backed secret storage
  | 'mobile' // no Electron at all on this platform
  | 'not-exposed' // require('electron') worked, but .safeStorage is missing/malformed —
  // almost certainly Obsidian's renderer sandbox, see point 1 above
  | 'unavailable' // safeStorage is present and well-shaped, but isEncryptionAvailable() says no
  | 'unprotected-backend'; // Linux hardcoded-password fallback — see point 2 above

let safeStorage: SafeStorageLike | null = null;
if (Platform.isDesktopApp) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as { safeStorage?: unknown };
    const candidate = electron?.safeStorage;
    // Verify the SHAPE, not just that something truthy came back — a
    // renderer-context require('electron') that doesn't expose this
    // module could plausibly hand back an object missing some or all of
    // these methods rather than `undefined` outright, and calling a
    // missing method later would throw somewhere far from this file's
    // own error handling.
    const looksUsable =
      !!candidate &&
      typeof (candidate as SafeStorageLike).isEncryptionAvailable === 'function' &&
      typeof (candidate as SafeStorageLike).encryptString === 'function' &&
      typeof (candidate as SafeStorageLike).decryptString === 'function';
    safeStorage = looksUsable ? (candidate as SafeStorageLike) : null;
  } catch {
    safeStorage = null;
  }
}

/**
 * Linux-only check for Electron's own "no real secret store, using a
 * hardcoded password" fallback (see point 2 in the module comment above).
 * `getSelectedStorageBackend` doesn't exist on every Electron version, so
 * its absence is treated as "can't tell, assume fine" rather than as a
 * failure — this is a best-effort upgrade to accuracy on platforms/
 * versions where the information is available, not a hard requirement.
 */
function usingUnprotectedBackend(): boolean {
  try {
    return safeStorage?.getSelectedStorageBackend?.() === 'basic_text';
  } catch {
    return false;
  }
}

function availabilityReason(): AvailabilityReason {
  if (!Platform.isDesktopApp) return 'mobile';
  if (!safeStorage) return 'not-exposed';
  let available: boolean;
  try {
    available = safeStorage.isEncryptionAvailable();
  } catch {
    available = false;
  }
  if (!available) return 'unavailable';
  if (usingUnprotectedBackend()) return 'unprotected-backend';
  return 'available';
}

export function encryptionAvailable(): boolean {
  return availabilityReason() === 'available';
}

/** Human-readable line for the settings tab, mirroring the original app's tokenStorageDescription(). */
export function secretStorageDescription(): string {
  switch (availabilityReason()) {
    case 'available':
      return 'Encrypted at rest via your OS keychain (Electron safeStorage).';
    case 'mobile':
      return 'No OS keychain on mobile — stored in plain text in this plugin\u2019s data.json.';
    case 'not-exposed':
      return (
        'Encryption isn\u2019t available in this session (Obsidian didn\u2019t expose Electron\u2019s safeStorage ' +
        'here) — stored in plain text in this plugin\u2019s data.json.'
      );
    case 'unprotected-backend':
      return (
        'No OS secret store (keyring/wallet) is running, so your OS falls back to an unprotected ' +
        'default \u2014 treated the same as no encryption. Stored in plain text in this plugin\u2019s data.json.'
      );
    case 'unavailable':
    default:
      return 'No OS keychain available on this machine — stored in plain text in this plugin\u2019s data.json.';
  }
}

/** Returns a value safe to persist via saveData(). Empty string in, empty string out. */
export function encryptSecret(value: string): string {
  if (!value) return '';
  if (encryptionAvailable()) {
    try {
      return 'enc:' + safeStorage!.encryptString(value).toString('base64');
    } catch {
      // fall through to plaintext if encryption throws for any reason
    }
  }
  return 'plain:' + value;
}

/** Reverses encryptSecret(). Returns '' if the value can't be decrypted on this machine/session. */
export function decryptSecret(stored: string | undefined): string {
  if (!stored) return '';
  if (stored.startsWith('enc:')) {
    if (!encryptionAvailable()) return '';
    try {
      return safeStorage!.decryptString(Buffer.from(stored.slice(4), 'base64'));
    } catch {
      return '';
    }
  }
  if (stored.startsWith('plain:')) return stored.slice(6);
  return stored;
}