/**
 * Redis connection hardening — shared by apps/api and apps/worker.
 * OWNERSHIP: packages/shared/src/redis
 *
 * SECURITY FIX (L-06): no TLS option was ever passed to any Redis client, so a
 * Redis on another host carried job payloads, bot-control commands and the
 * password itself in plaintext. This module is deliberately dependency-free
 * (it returns a plain options object; it does NOT import ioredis) so both
 * processes can share ONE implementation instead of two drifting copies.
 *
 * Configuration (opt-in — forcing TLS would stop the bundled docker-compose
 * Redis, which has none on its private network, from connecting):
 *   REDIS_URL=rediss://...            scheme alone enables TLS (ioredis convention)
 *   REDIS_TLS=true                    enable TLS even with a redis:// URL
 *   REDIS_TLS_CA=<path or PEM>        custom CA (managed Redis / self-signed)
 *   REDIS_TLS_REJECT_UNAUTHORIZED=false   encrypt WITHOUT verifying the server (last resort)
 *   REDIS_TLS=false                   explicit "trusted private network" — silences
 *                                     the production warning for a non-local host
 */
import { readFileSync } from "node:fs";

export interface RedisTlsOptions {
  servername?:        string;
  minVersion:         "TLSv1.2";
  rejectUnauthorized: boolean;
  ca?:                string;
}

export interface ResolvedRedisTls {
  /** Spread into the ioredis options. Empty object = plain TCP. */
  options: { tls?: RedisTlsOptions };
  /** True when the connection will be encrypted. */
  enabled: boolean;
}

type Env  = Record<string, string | undefined>;
type Warn = (fields: Record<string, unknown>, message: string) => void;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", ""]);
const TRUE_VALUES  = new Set(["true", "1", "on", "require", "required"]);
const FALSE_VALUES = new Set(["false", "0", "off"]);

export function resolveRedisTls(
  url: string,
  warn: Warn,
  env: Env = process.env,
): ResolvedRedisTls {
  let protocol = "";
  let host     = "";
  try {
    const u = new URL(url);
    protocol = u.protocol.toLowerCase();
    host     = u.hostname.toLowerCase();
  } catch { /* ioredis will surface a malformed URL itself */ }

  const mode    = (env.REDIS_TLS ?? "").trim().toLowerCase();
  const wantTls = TRUE_VALUES.has(mode) || (protocol === "rediss:" && !FALSE_VALUES.has(mode));

  if (!wantTls) {
    if (env.NODE_ENV === "production" && !FALSE_VALUES.has(mode) && !LOCAL_HOSTS.has(host)) {
      warn(
        { host },
        "REDIS_URL points at a non-local host but TLS is not enabled — job payloads, bot-control commands and the " +
        "Redis password travel unencrypted. Use a rediss:// URL or set REDIS_TLS=true (and REDIS_TLS_CA if needed), " +
        "or REDIS_TLS=false to acknowledge a trusted private network.",
      );
    }
    return { options: {}, enabled: false };
  }

  const rejectUnauthorized = (env.REDIS_TLS_REJECT_UNAUTHORIZED ?? "").trim().toLowerCase() !== "false";
  if (!rejectUnauthorized) {
    warn({}, "REDIS_TLS_REJECT_UNAUTHORIZED=false — Redis traffic is encrypted but the server's identity is NOT verified (MITM possible).");
  }

  const tls: RedisTlsOptions = { minVersion: "TLSv1.2", rejectUnauthorized };
  if (host && !LOCAL_HOSTS.has(host)) tls.servername = host; // SNI; not valid for bare IPs on some servers, harmless otherwise

  const ca = env.REDIS_TLS_CA?.trim();
  if (ca) {
    tls.ca = ca.includes("-----BEGIN") ? ca.replace(/\\n/g, "\n") : readFileSync(ca, "utf8");
  }

  return { options: { tls }, enabled: true };
}
