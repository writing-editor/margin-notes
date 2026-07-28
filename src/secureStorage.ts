import { Platform } from 'obsidian';

// Obsidian plugins run with full Node/Electron access on desktop (no
// sandboxing), so requiring Electron's safeStorage directly — the same
// module the original app's electron/ai-keystore.js wraps — works here too.
// It's unavailable on mobile (no Electron) and, rarely, on a minimal Linux
// install with no keyring backend; both cases fall back to plaintext, same
// as the original app did, and we say so rather than pretending otherwise.
interface SafeStorageLike {
  isEncryptionAvailable: () => boolean;
  encryptString: (plainText: string) => Buffer;
  decryptString: (encrypted: Buffer) => string;
}

let safeStorage: SafeStorageLike | null = null;
if (Platform.isDesktopApp) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    safeStorage = (require('electron') as { safeStorage: SafeStorageLike }).safeStorage;
  } catch {
    safeStorage = null;
  }
}

function encryptionAvailable(): boolean {
  try {
    return !!safeStorage?.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** Human-readable line for the settings tab, mirroring the original app's tokenStorageDescription(). */
export function secretStorageDescription(): string {
  if (encryptionAvailable()) return 'Encrypted at rest via your OS keychain (Electron safeStorage).';
  if (Platform.isDesktopApp) return 'No OS keychain available on this machine — stored in plain text in this plugin\u2019s data.json.';
  return 'No OS keychain on mobile — stored in plain text in this plugin\u2019s data.json.';
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
