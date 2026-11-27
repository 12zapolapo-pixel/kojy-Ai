/**
 * fetch_url — Kojy reads a public web page or JSON (library docs, an API's
 * reference, PyPI) as text. Owner requests only (never in automatic fixes).
 * OWNERSHIP: apps/runner/src/agent
 *
 * The runner sits on KojyAI's private network (Postgres, Redis, the API), so
 * only public addresses are reachable: every address a host name resolves to
 * is checked when the connection is made (no DNS-rebinding window), redirects
 * are followed by hand and checked again, ports are 80/443 only, and no
 * credentials ride along. Pages are size- and time-limited, and what comes
 * back is untrusted data for the model.
 */

import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 4;
export const MAX_TEXT = 12_000;

const BLOCKED = new net.BlockList();
for (const [a, p] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) {
  BLOCKED.addSubnet(a, p, "ipv4");
}
for (const [a, p] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96], ["2001:db8::", 32]] as const) {
  BLOCKED.addSubnet(a, p, "ipv6");
}

/** Whether an address is private, local or otherwise not on the public internet (IPv4-mapped IPv6 included). */
export function isPrivateAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped) return isPrivateAddress(mapped);
  const family = net.isIP(ip);
  if (!family) return true;
  return BLOCKED.check(ip, family === 4 ? "ipv4" : "ipv6");
}

/** Why a URL may not be fetched (null: it may). */
export function urlProblem(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return "That isn't a full web address (https://…)."; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "Only http:// and https:// addresses can be read.";
  if (u.username || u.password) return "Addresses with a user name or password aren't read.";
  if (u.port && u.port !== "80" && u.port !== "443") return "Only the usual web ports (80, 443) can be read.";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isPrivateAddress(host)) return "That address is on a private network; only public web pages can be read.";
  if (/^(localhost|.*\.local|.*\.internal|.*\.localdomain)$/i.test(host) || !host.includes(".")) return "Only public web pages can be read.";
  return null;
}

type Lookup = typeof dnsLookup;
/** A DNS lookup that refuses private addresses — used for the connection itself. */
function publicOnly(allow: (ip: string) => boolean): Lookup {
  return ((host: string, opts: unknown, cb: (err: Error | null, address: unknown, family?: number) => void) => {
    dnsLookup(host, { ...(opts as object), all: true }, (err, addresses) => {
      if (err) return cb(err, "", 4);
      const list = addresses as { address: string; family: number }[];
      const bad = list.find((a) => !allow(a.address));
      if (bad || !list.length) return cb(new Error("refused: that host is on a private network"), "", 4);
      if ((opts as { all?: boolean } | undefined)?.all) return cb(null, list);
      cb(null, list[0]!.address, list[0]!.family);
    });
  }) as unknown as Lookup;
}

/** Visible text of an HTML page: scripts, styles and navigation dropped, blocks on their own lines. */
export function htmlToText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  const body = html
    .replace(/<head\b[\s\S]*?<\/head>/i, " ")
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/pre|\/section|\/article)\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return title ? `${title}\n\n${body}` : body;
}

export interface FetchedPage { url: string; status: number; contentType: string; text: string; clipped: boolean }

/** Reads a public page as text. `allow` decides which resolved addresses are fine (tests only); `opts.raw` keeps the page's HTML as it came (web_search reads its links). */
export async function fetchPublic(raw: string, allow: (ip: string) => boolean = (ip) => !isPrivateAddress(ip), opts: { raw?: boolean } = {}): Promise<FetchedPage> {
  let url = raw.trim();
  for (let hop = 0; ; hop++) {
    const problem = urlProblem(url);
    if (problem) throw new Error(problem);
    const u = new URL(url);
    const res = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const lib = u.protocol === "https:" ? https : http;
      const req = lib.request(u, {
        method: "GET", lookup: publicOnly(allow), timeout: TIMEOUT_MS,
        headers: { "user-agent": "KojyAI-coder/1.0 (+documentation reader)", accept: "text/html,application/json,text/plain,application/xml;q=0.9,*/*;q=0.5", "accept-encoding": "identity" },
      }, (r) => {
        const chunks: Buffer[] = [];
        let size = 0;
        r.on("data", (c: Buffer) => { size += c.length; if (size <= MAX_BYTES) chunks.push(c); else r.destroy(); });
        r.on("end", () => resolve({ status: r.statusCode ?? 0, headers: r.headers, body: Buffer.concat(chunks) }));
        r.on("close", () => resolve({ status: r.statusCode ?? 0, headers: r.headers, body: Buffer.concat(chunks) }));
        r.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new Error(`no answer within ${TIMEOUT_MS / 1000}s`)));
      req.on("error", reject);
      req.end();
    });
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      if (hop >= MAX_REDIRECTS) throw new Error("Too many redirects.");
      url = new URL(res.headers.location, url).toString();
      continue;
    }
    const contentType = String(res.headers["content-type"] ?? "").toLowerCase();
    if (contentType && !/text\/|json|xml|javascript/.test(contentType)) throw new Error(`That address isn't a text page (${contentType.split(";")[0]}).`);
    let text = res.body.toString("utf8");
    if (opts.raw) return { url, status: res.status, contentType: contentType.split(";")[0] ?? "", text, clipped: false };
    if (/html/.test(contentType) || /^\s*<(!doctype html|html)/i.test(text)) text = htmlToText(text);
    else if (/json/.test(contentType)) {
      const pypi = /(^|\.)pypi\.org$/i.test(u.hostname) ? summarizePypi(text) : null;
      if (pypi) text = pypi;
      else { try { text = JSON.stringify(JSON.parse(text), null, 1); } catch { /* as it came */ } }
    }
    const clipped = text.length > MAX_TEXT;
    return { url, status: res.status, contentType: contentType.split(";")[0] ?? "", text: clipped ? text.slice(0, MAX_TEXT) : text, clipped };
  }
}

/** PyPI's JSON for a package, cut down to what choosing a requirement takes (the full JSON lists every file of every release). */
export function summarizePypi(text: string): string | null {
  try {
    const j = JSON.parse(text) as { info?: { name?: string; version?: string; summary?: string; requires_python?: string; requires_dist?: string[] | null; home_page?: string; project_urls?: Record<string, string> | null }; releases?: Record<string, unknown> };
    if (!j.info?.name) return null;
    const i = j.info;
    const recent = Object.keys(j.releases ?? {}).slice(-8).join(", ");
    return [
      `${i.name} ${i.version} — ${i.summary ?? ""}`,
      i.requires_python ? `Python: ${i.requires_python}` : "",
      i.requires_dist?.length ? `Needs: ${i.requires_dist.slice(0, 15).join("; ")}` : "",
      recent ? `Recent versions: ${recent}` : "",
      Object.entries(i.project_urls ?? {}).slice(0, 5).map(([k, v]) => `${k}: ${v}`).join("\n"),
    ].filter(Boolean).join("\n");
  } catch { return null; }
}
