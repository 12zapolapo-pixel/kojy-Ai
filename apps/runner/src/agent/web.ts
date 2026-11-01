/**
 * Internet access for the coder AI: a web search and reading one page.
 * OWNERSHIP: apps/runner/src/agent
 *
 * The runner sits on the same network as the database, Redis and the API,
 * and the server can reach the cloud's metadata address, so every address a
 * request would go to (after DNS, and again after each redirect) must be a
 * public one: no private, loopback, link-local or other special ranges, only
 * http(s) on ports 80/443. Pages come back as plain text, size-capped. What a
 * page says is data for the AI, never instructions (see the prompt).
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";

const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 4;
const UA = "Mozilla/5.0 (compatible; KojyAI-coder/1.0; +https://github.com/12zapolapo-pixel/kojy-ai)";

export class WebError extends Error {}

/** True for addresses a request must never reach. */
export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isBlockedAddress(mapped[1]!);
    return x === "::" || x === "::1" || /^(fc|fd|fe[89ab]|ff)/.test(x) || x.startsWith("64:ff9b:") || x.startsWith("2001:db8");
  }
  return true;
}

/** Checks a URL and resolves it to one public address (the request connects to exactly that address). */
export async function checkUrl(raw: string): Promise<{ url: URL; address: string; family: number }> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new WebError("Not a valid URL."); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new WebError("Only http and https addresses.");
  if (url.username || url.password) throw new WebError("Addresses with a login in them aren't allowed.");
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (port !== 80 && port !== 443) throw new WebError("Only the normal web ports (80, 443).");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.local|.*\.internal|metadata.*)$/i.test(host)) throw new WebError("That address is inside the server's network.");
  const found = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true }).catch(() => { throw new WebError(`Couldn't find ${host}.`); });
  if (!found.length || found.some((a) => isBlockedAddress(a.address))) throw new WebError("That address is inside a private network; only public websites can be read.");
  return { url, address: found[0]!.address, family: found[0]!.family };
}

/** A DNS lookup that always answers with the checked address (Node asks for a list when options.all is set). */
export function pinnedLookup(address: string, family: number) {
  return (_host: string, options: { all?: boolean | undefined } | number | undefined, cb: (...args: unknown[]) => void) => {
    if (typeof options === "object" && options?.all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  };
}

interface Got { status: number; type: string; body: string; finalUrl: string }

/** GET with the address pinned to the checked one, redirects re-checked, size and time capped. */
export async function get(raw: string, accept = "text/html,application/json,text/plain;q=0.9,*/*;q=0.5"): Promise<Got> {
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { url, address, family } = await checkUrl(current);
    const res = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const lib = url.protocol === "https:" ? https : http;
      const req = lib.request(url, {
        method: "GET", timeout: TIMEOUT_MS,
        headers: { "user-agent": UA, accept, "accept-language": "en" },
        // Connect to the address that was checked, not whatever DNS says a moment later.
        lookup: pinnedLookup(address, family) as never,
      }, (r) => {
        const chunks: Buffer[] = [];
        let size = 0;
        r.on("data", (c: Buffer) => { size += c.length; if (size > MAX_BYTES) { r.destroy(); return; } chunks.push(c); });
        r.on("end", () => resolve({ status: r.statusCode ?? 0, headers: r.headers, body: Buffer.concat(chunks) }));
        r.on("close", () => resolve({ status: r.statusCode ?? 0, headers: r.headers, body: Buffer.concat(chunks) }));
        r.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new WebError("The site took too long to answer.")));
      req.on("error", (e) => reject(e instanceof WebError ? e : new WebError(`Couldn't load it: ${e.message}`)));
      req.end();
    });
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      current = new URL(res.headers.location, url).toString();
      continue;
    }
    return { status: res.status, type: String(res.headers["content-type"] ?? ""), body: res.body.toString("utf8"), finalUrl: url.toString() };
  }
  throw new WebError("Too many redirects.");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
const decode = (s: string) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
  if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENTITIES[e.toLowerCase()] ?? m;
});

/** HTML → readable text: drops scripts/styles/nav, keeps headings, list items and code blocks. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "");
  let s = html.replace(/<(script|style|noscript|svg|head|nav|footer|iframe|form)\b[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, code: string) => `\n\`\`\`\n${code.replace(/<[^>]+>/g, "")}\n\`\`\`\n`);
  s = s.replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n\n${"#".repeat(Number(n))} `).replace(/<\/h[1-6]>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ").replace(/<(br|\/p|\/div|\/tr|\/section|\/article)\b[^>]*>/gi, "\n").replace(/<code\b[^>]*>/gi, "`").replace(/<\/code>/gi, "`");
  s = decode(s.replace(/<[^>]+>/g, " "));
  s = s.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).filter((l, i, a) => l || (a[i - 1] ?? "") !== "").join("\n");
  return { title, text: s.replace(/\n{3,}/g, "\n\n").trim() };
}

export interface SearchHit { title: string; url: string; snippet: string }

/** DuckDuckGo's HTML results page (no key needed): title, real URL and snippet of each result. */
export function parseSearch(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/i).slice(1);
  for (const b of blocks) {
    const a = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(b);
    if (!a) continue;
    let href = decode(a[1]!);
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    if (uddg) href = decodeURIComponent(uddg[1]!);
    if (href.startsWith("//")) href = `https:${href}`;
    if (!/^https?:\/\//.test(href) || /duckduckgo\.com\/y\.js/.test(href)) continue; // ads
    const snippet = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(a|div|td)>/i.exec(b)?.[1] ?? "";
    hits.push({ title: decode(a[2]!.replace(/<[^>]+>/g, "")).trim(), url: href, snippet: decode(snippet.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() });
    if (hits.length >= 8) break;
  }
  return hits;
}

export async function webSearch(query: string): Promise<SearchHit[]> {
  const q = query.trim().slice(0, 300);
  if (!q) throw new WebError("Empty search.");
  const r = await get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=us-en`, "text/html");
  if (r.status !== 200) throw new WebError(`The search engine answered HTTP ${r.status}; try again in a moment or read a known page with fetch_url.`);
  return parseSearch(r.body);
}

/** One page as text: HTML is converted, JSON pretty-printed, other text kept; from `start` characters, up to `max`. */
export async function fetchPage(raw: string, start = 0, max = 8000): Promise<{ url: string; title: string; text: string; total: number }> {
  const r = await get(raw);
  if (r.status >= 400) throw new WebError(`The site answered HTTP ${r.status}.`);
  let title = "", text = r.body;
  if (/html/i.test(r.type) || /^\s*<(!doctype|html)/i.test(r.body)) ({ title, text } = htmlToText(r.body));
  else if (/json/i.test(r.type)) { try { text = JSON.stringify(JSON.parse(r.body), null, 1); } catch { /* keep raw */ } }
  else if (!/^text\/|xml|javascript/i.test(r.type) && r.type) throw new WebError(`That's not a text page (${r.type}).`);
  return { url: r.finalUrl, title, text: text.slice(start, start + max), total: text.length };
}
