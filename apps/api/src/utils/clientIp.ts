/**
 * Client IP resolution — shared by the HTTP server (boot.ts) and the WebSocket
 * gateway so both apply the SAME spoof-resistant rule.
 * OWNERSHIP: apps/api/src/utils
 *
 * SECURITY FIX (X-Forwarded-For spoofing): used to return the LEFTMOST
 * X-Forwarded-For entry. Each proxy APPENDS the address it received the
 * request from, so the leftmost entry is whatever the original client chose to
 * send — sending `X-Forwarded-For: <random ip>` on every request gave an
 * attacker a fresh rate-limit identity each time, defeating the login rate
 * limit and the M-01 flood guard entirely (and letting them frame other IPs in
 * audit logs).
 *
 * Correct rule: only the proxies WE run are trusted. Walk the chain from the
 * RIGHT (nearest hop) and skip trusted proxies; the first address that is not
 * one of ours is the real client, because it was appended by a proxy we trust.
 * Anything further left is client-controlled and is never consulted.
 *
 * Also normalizes IPv4-mapped IPv6 ("::ffff:10.0.0.5") so trusted-proxy
 * matching works however the socket reports the address, and validates every
 * candidate with net.isIP so junk can't become a rate-limit / Redis key.
 *
 * NOTE: TRUSTED_PROXIES is read lazily (first call), not at import time, so it
 * never depends on module evaluation order relative to .env loading.
 */
import { isIP } from "node:net";
import { createLogger } from "./logger.js";

const log = createLogger("client-ip");

export function normalizeIp(raw: string): string {
  const ip = raw.trim();
  return ip.toLowerCase().startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

let _trusted: Set<string> | null = null;
export function getTrustedProxies(): Set<string> {
  if (!_trusted) {
    _trusted = new Set(
      (process.env.TRUSTED_PROXY_IPS ?? "127.0.0.1,::1")
        .split(",")
        .map((ip) => normalizeIp(ip))
        .filter(Boolean),
    );
  }
  return _trusted;
}

const warnedForwarders = new Set<string>();
const MAX_WARNED_FORWARDERS = 25; // bounded: peer addresses are attacker-influenced
function warnUntrustedForwarder(peer: string): void {
  if (warnedForwarders.has(peer) || warnedForwarders.size >= MAX_WARNED_FORWARDERS) return;
  warnedForwarders.add(peer);
  log.warn(
    { peer, trustedProxies: [...getTrustedProxies()] },
    "Received X-Forwarded-For from a peer that is NOT in TRUSTED_PROXY_IPS — the header was ignored. " +
    "If this peer is your load balancer / reverse proxy, add it to TRUSTED_PROXY_IPS, otherwise all " +
    "users behind it share one rate-limit bucket. (If it's an arbitrary client spoofing the header, ignore this.)",
  );
}

const warnedNoForward = new Set<string>();
function warnTrustedProxyWithoutForwarding(peer: string): void {
  if (warnedNoForward.has(peer) || warnedNoForward.size >= MAX_WARNED_FORWARDERS) return;
  warnedNoForward.add(peer);
  log.warn(
    { peer },
    "A request arrived from a TRUSTED proxy address with no X-Forwarded-For header — the proxy is not forwarding " +
    "client IPs (or TRUSTED_PROXY_IPS lists a host that isn't actually a proxy), so every client behind it " +
    "will share this one address for rate limiting. Configure the proxy to set X-Forwarded-For.",
  );
}

const isLoopback = (ip: string): boolean => ip === "127.0.0.1" || ip === "::1";

/**
 * @param socketAddr  the TCP peer address (req.socket.remoteAddress)
 * @param xff         the raw X-Forwarded-For header value, if any
 */
export function resolveClientIp(socketAddr: string | undefined, xff: string | string[] | undefined): string {
  const socketIp = socketAddr ? normalizeIp(socketAddr) : undefined;
  const trusted = getTrustedProxies();
  const xffHeader = Array.isArray(xff) ? xff.join(",") : xff;

  // Not behind a proxy we trust -> forwarded headers are attacker-controlled.
  if (!socketIp || !trusted.has(socketIp)) {
    // SECURITY FIX (L-01): runtime misconfiguration check. A request carrying
    // X-Forwarded-For from a peer we DON'T trust is either a client spoofing the
    // header (harmless, ignored) or our real load balancer missing from
    // TRUSTED_PROXY_IPS (every user silently shares the LB's rate-limit bucket).
    // Can't tell apart per-request, so warn once per peer (bounded).
    if (socketIp && xffHeader) warnUntrustedForwarder(socketIp);
    return socketIp ?? "unknown";
  }

  // L-01, the other direction: a peer we trust that sends no forwarding header.
  // (Loopback is exempt: local health checks and dev servers legitimately have none.)
  if (!xffHeader && !isLoopback(socketIp)) warnTrustedProxyWithoutForwarding(socketIp);

  if (xffHeader) {
    const hops = xffHeader.split(",").map(normalizeIp).filter(Boolean);
    for (let i = hops.length - 1; i >= 0; i--) {
      const hop = hops[i]!;
      if (trusted.has(hop)) continue; // one of our own proxies — keep walking left
      // First non-trusted hop = the client as seen by our outermost proxy.
      // If it isn't even a valid IP, stop trusting the header entirely.
      return isIP(hop) ? hop : socketIp;
    }
  }
  return socketIp;
}
