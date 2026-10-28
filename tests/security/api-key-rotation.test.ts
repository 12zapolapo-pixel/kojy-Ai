/** L-26: API-key encryption versioning + rotation. Pure unit tests, no DB. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import { encryptApiKey, decryptApiKey, isEncrypted, getKeyId, needsReencryption, reencryptApiKey, migrateKey } from "../../packages/shared/src/crypto/apiKeys";

const K1 = "11".repeat(32), K2 = "22".repeat(32), K3 = "33".repeat(32);
const saved = { ...process.env };
const setEnv = (e: Record<string, string | undefined>) => { for (const k of ["ENCRYPTION_KEY", "ENCRYPTION_KEY_ID", "ENCRYPTION_KEYS_PREVIOUS"]) delete process.env[k]; Object.assign(process.env, e); };
beforeEach(() => setEnv({ ENCRYPTION_KEY: K1 }));
afterEach(() => { process.env = { ...saved }; });

describe("L-26 key versioning", () => {
  it("legacy (no id) round-trips and stays 3-part when ENCRYPTION_KEY_ID is unset", () => {
    const c = encryptApiKey("secret-abc"); expect(c.split(":")).toHaveLength(3); expect(getKeyId(c)).toBeNull();
    expect(decryptApiKey(c)).toBe("secret-abc"); expect(needsReencryption(c)).toBe(false);
  });
  it("versioned writes carry the id and round-trip", () => {
    setEnv({ ENCRYPTION_KEY: K1, ENCRYPTION_KEY_ID: "1" });
    const c = encryptApiKey("k"); expect(c.split(":")).toHaveLength(4); expect(getKeyId(c)).toBe("1");
    expect(decryptApiKey(c)).toBe("k"); expect(isEncrypted(c)).toBe(true);
  });
  it("rotation: old values still decrypt, new writes use the new key, migration re-encrypts", () => {
    setEnv({ ENCRYPTION_KEY: K1, ENCRYPTION_KEY_ID: "1" });
    const old = encryptApiKey("highrise-token");
    const legacy = (setEnv({ ENCRYPTION_KEY: K1 }), encryptApiKey("legacy-token"));
    setEnv({ ENCRYPTION_KEY: K2, ENCRYPTION_KEY_ID: "2", ENCRYPTION_KEYS_PREVIOUS: `1:${K1}` });
    expect(decryptApiKey(old)).toBe("highrise-token");
    expect(decryptApiKey(legacy)).toBe("legacy-token");          // unversioned: tried against previous keys
    expect(getKeyId(encryptApiKey("x"))).toBe("2");
    expect(needsReencryption(old)).toBe(true); expect(needsReencryption(legacy)).toBe(true);
    const moved = reencryptApiKey(old); expect(getKeyId(moved)).toBe("2"); expect(needsReencryption(moved)).toBe(false);
    expect(reencryptApiKey(legacy)).not.toBe(legacy);
    // once the old key is dropped, the re-encrypted value still works and the un-migrated one fails closed
    setEnv({ ENCRYPTION_KEY: K2, ENCRYPTION_KEY_ID: "2" });
    expect(decryptApiKey(moved)).toBe("highrise-token");
    expect(() => decryptApiKey(old)).toThrow(/not configured/);
  });
  it("fails closed: wrong key, unknown id, tampering, garbage", () => {
    setEnv({ ENCRYPTION_KEY: K1, ENCRYPTION_KEY_ID: "1" }); const c = encryptApiKey("k");
    setEnv({ ENCRYPTION_KEY: K3, ENCRYPTION_KEY_ID: "1" }); expect(() => decryptApiKey(c)).toThrow(/decryption failed/);
    setEnv({ ENCRYPTION_KEY: K1, ENCRYPTION_KEY_ID: "1" });
    const p = c.split(":"); p[2] = Buffer.from("tampered!!").toString("base64"); expect(() => decryptApiKey(p.join(":"))).toThrow();
    expect(() => decryptApiKey("not-encrypted")).toThrow(/Invalid encrypted key format/);
    expect(migrateKey("plain-highrise-key")).not.toBe("plain-highrise-key");
  });
  it("rejects a truncated auth tag (GCM would otherwise accept short tags)", () => {
    const iv = randomBytes(16), ci = createCipheriv("aes-256-gcm", Buffer.from(K1, "hex"), iv);
    const ct = Buffer.concat([ci.update("hello"), ci.final()]); const tag = ci.getAuthTag().subarray(0, 4);
    expect(() => decryptApiKey([iv, ct, tag].map((b) => b.toString("base64")).join(":"))).toThrow();
  });
  it("rejects malformed key material instead of silently using a short key", () => {
    setEnv({ ENCRYPTION_KEY: "zz" + "11".repeat(31) }); expect(() => encryptApiKey("x")).toThrow(/64-character hex/);
    setEnv({ ENCRYPTION_KEY: K1, ENCRYPTION_KEY_ID: "bad id!" }); expect(() => encryptApiKey("x")).toThrow(/ENCRYPTION_KEY_ID/);
    setEnv({ ENCRYPTION_KEY: K1, ENCRYPTION_KEY_ID: "1", ENCRYPTION_KEYS_PREVIOUS: `1:${K2}` }); expect(() => encryptApiKey("x")).toThrow(/reuses the current key id/);
    setEnv({ ENCRYPTION_KEY: K1, ENCRYPTION_KEYS_PREVIOUS: "nocolon" }); expect(() => encryptApiKey("x")).toThrow(/id:hex/);
  });
});
