/**
 * AES-256-GCM API Key Encryption — with key versioning
 * OWNERSHIP: packages/shared/src/crypto
 *
 * STORAGE FORMATS (both are always readable):
 *   legacy / unversioned : base64(iv):base64(ciphertext):base64(authTag)
 *   versioned            : <keyId>:base64(iv):base64(ciphertext):base64(authTag)
 *
 * SECURITY FIX (L-26): there used to be exactly one key and no marker saying
 * which key produced a value, so rotating ENCRYPTION_KEY meant every stored
 * credential became undecryptable at once, with no way to migrate gradually.
 *
 * CONFIGURATION
 *   ENCRYPTION_KEY           64 hex chars (32 bytes) — the CURRENT key, used for all new writes.
 *   ENCRYPTION_KEY_ID        optional short id for the current key ([A-Za-z0-9_-]{1,16}).
 *                            When set, new values are written in the versioned format.
 *                            When unset, writes stay in the legacy format (so rolling back
 *                            to older code remains possible).
 *   ENCRYPTION_KEYS_PREVIOUS optional "id:hex,id:hex" — retired keys, DECRYPT-ONLY.
 *
 * ROTATION PROCEDURE (no downtime, no big-bang re-encrypt)
 *   1. Generate a new key:                   openssl rand -hex 32
 *   2. Move the old key into previous:       ENCRYPTION_KEYS_PREVIOUS="1:<old hex>"
 *      (if the old key had no id, give it one here — unversioned values are tried
 *      against the current key and then every previous key, so nothing breaks)
 *   3. Set the new key + id:                 ENCRYPTION_KEY=<new hex>  ENCRYPTION_KEY_ID=2
 *   4. Deploy. Old values still decrypt; every NEW write uses key 2.
 *   5. Re-encrypt the rest:                  npx tsx apps/api/src/scripts/migrate-encrypt-api-keys.ts
 *      (it re-encrypts anything not already under the current key id; idempotent)
 *   6. When the script reports 0 remaining, remove the old key from ENCRYPTION_KEYS_PREVIOUS.
 *
 * Fail-closed: decryption throws rather than returning corrupted plaintext.
 * Never log plaintext keys.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM   = "aes-256-gcm";
const IV_BYTES    = 16;
const TAG_BYTES   = 16;
const SEPARATOR   = ":";
const HEX_KEY_RE  = /^[0-9a-fA-F]{64}$/;
const KEY_ID_RE   = /^[A-Za-z0-9_-]{1,16}$/;
const B64_RE      = /^[A-Za-z0-9+/=]+$/;

interface KeyRing {
  currentId: string | null;
  current:   Buffer;
  previous:  Map<string, Buffer>;
}

function parseHexKey(hex: string, what: string): Buffer {
  // Buffer.from(hex, "hex") silently stops at the first non-hex character, so an
  // unvalidated value could yield a SHORTER (weaker or invalid) key than intended.
  if (!HEX_KEY_RE.test(hex)) {
    throw new Error(`${what} must be a 64-character hex string (32 bytes). Generate with: openssl rand -hex 32`);
  }
  return Buffer.from(hex, "hex");
}

let ringCache: { signature: string; ring: KeyRing } | null = null;

function getKeyRing(): KeyRing {
  const keyHex   = process.env.ENCRYPTION_KEY;
  const idRaw    = process.env.ENCRYPTION_KEY_ID?.trim() || "";
  const prevRaw  = process.env.ENCRYPTION_KEYS_PREVIOUS?.trim() || "";
  const signature = `${keyHex}|${idRaw}|${prevRaw}`;
  if (ringCache && ringCache.signature === signature) return ringCache.ring;

  if (!keyHex) {
    throw new Error("ENCRYPTION_KEY must be set to a 64-character hex string (32 bytes). Generate with: openssl rand -hex 32");
  }
  const current = parseHexKey(keyHex, "ENCRYPTION_KEY");

  let currentId: string | null = null;
  if (idRaw) {
    if (!KEY_ID_RE.test(idRaw)) throw new Error("ENCRYPTION_KEY_ID must match [A-Za-z0-9_-]{1,16}");
    currentId = idRaw;
  }

  const previous = new Map<string, Buffer>();
  if (prevRaw) {
    for (const entry of prevRaw.split(",").map((e) => e.trim()).filter(Boolean)) {
      const idx = entry.indexOf(SEPARATOR);
      const id  = idx === -1 ? "" : entry.slice(0, idx);
      if (!KEY_ID_RE.test(id)) throw new Error("ENCRYPTION_KEYS_PREVIOUS entries must look like id:hex (id = [A-Za-z0-9_-]{1,16})");
      if (id === currentId)    throw new Error(`ENCRYPTION_KEYS_PREVIOUS reuses the current key id "${id}"`);
      if (previous.has(id))    throw new Error(`ENCRYPTION_KEYS_PREVIOUS lists key id "${id}" twice`);
      previous.set(id, parseHexKey(entry.slice(idx + 1), `ENCRYPTION_KEYS_PREVIOUS["${id}"]`));
    }
  }

  const ring = { currentId, current, previous };
  ringCache = { signature, ring };
  return ring;
}

/**
 * Encrypts a plaintext API key with the CURRENT key and returns a storable string.
 */
export function encryptApiKey(plaintext: string): string {
  const { currentId, current } = getKeyRing();
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv(ALGORITHM, current, iv, { authTagLength: TAG_BYTES });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const body = [iv.toString("base64"), encrypted.toString("base64"), tag.toString("base64")];
  return (currentId ? [currentId, ...body] : body).join(SEPARATOR);
}

function decryptWith(key: Buffer, ivB64: string, ciphertextB64: string, tagB64: string): string {
  const iv  = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  // Node's GCM accepts truncated tags unless the length is pinned, which weakens
  // authentication; pinning authTagLength + checking it here rejects them.
  if (tag.length !== TAG_BYTES) throw new Error("bad tag length");

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(ciphertextB64, "base64")), decipher.final()]).toString("utf8");
}

/**
 * Decrypts a stored API key. Throws if decryption fails — never returns garbage.
 * Versioned values use the key named by their id; unversioned (legacy) values are
 * tried against the current key and then every previous key.
 */
export function decryptApiKey(encrypted: string): string {
  const parts = encrypted.split(SEPARATOR);

  if (parts.length !== 3 && parts.length !== 4) {
    throw new Error("Invalid encrypted key format. Run migration to re-encrypt plaintext keys.");
  }

  const ring = getKeyRing();

  if (parts.length === 4) {
    const [id, ivB64, ctB64, tagB64] = parts as [string, string, string, string];
    const key = id === ring.currentId ? ring.current : ring.previous.get(id);
    if (!key) {
      throw new Error(
        `API key was encrypted with key id "${id}", which is not configured. ` +
        "Add it to ENCRYPTION_KEYS_PREVIOUS (as id:hex) or restore it as ENCRYPTION_KEY.",
      );
    }
    try {
      return decryptWith(key, ivB64, ctB64, tagB64);
    } catch {
      throw new Error(`API key decryption failed for key id "${id}". The value may be corrupt or that key's material is wrong.`);
    }
  }

  const [ivB64, ctB64, tagB64] = parts as [string, string, string];
  for (const key of [ring.current, ...ring.previous.values()]) {
    try { return decryptWith(key, ivB64, ctB64, tagB64); } catch { /* try the next key */ }
  }
  throw new Error("API key decryption failed. The key may be corrupt or the ENCRYPTION_KEY has changed.");
}

/**
 * Returns true if the value is already encrypted (3-part legacy or 4-part versioned).
 */
export function isEncrypted(value: string): boolean {
  const parts = value.split(SEPARATOR);
  if (parts.length === 3) return parts.every((p) => B64_RE.test(p));
  if (parts.length === 4) return KEY_ID_RE.test(parts[0]!) && parts.slice(1).every((p) => B64_RE.test(p));
  return false;
}

/** The key id a versioned value was encrypted under, or null for a legacy/unversioned value. */
export function getKeyId(value: string): string | null {
  const parts = value.split(SEPARATOR);
  return parts.length === 4 && KEY_ID_RE.test(parts[0]!) ? parts[0]! : null;
}

/**
 * True if the value is encrypted but NOT under the current key id — i.e. it
 * should be re-encrypted by the rotation migration. A legacy value only needs
 * re-encryption once ENCRYPTION_KEY_ID is set (until then legacy IS current).
 */
export function needsReencryption(value: string): boolean {
  if (!isEncrypted(value)) return false;
  return getKeyId(value) !== getKeyRing().currentId;
}

/** Decrypts with whichever configured key matches and re-encrypts under the current one. */
export function reencryptApiKey(value: string): string {
  return encryptApiKey(decryptApiKey(value));
}

/**
 * Re-encrypts a plaintext key in the database.
 * Call from a migration script — does nothing if the key is already encrypted.
 */
export function migrateKey(currentValue: string): string {
  if (isEncrypted(currentValue)) return currentValue;
  return encryptApiKey(currentValue);
}
