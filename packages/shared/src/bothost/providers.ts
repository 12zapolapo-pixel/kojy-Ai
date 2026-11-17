/**
 * Bot hosts KojyAI can run bots on: control panels with a Pterodactyl-style
 * client API (power, files, startup settings and a live console websocket).
 * OWNERSHIP: packages/shared/src/bothost
 *
 * Only panels listed here can be used, and their API address never comes
 * from a user, so connecting a host can't make KojyAI's servers call an
 * internal address (SSRF). An admin can add panels with BOT_HOST_PANELS, a
 * JSON list of {id, label, apiUrl, origin, nodeDomains, keyHelp}.
 */

export interface BotHostProvider {
  id: string;
  label: string;
  /** The panel's client API, e.g. https://example.com/api/client. */
  apiUrl: string;
  /** Sent as Origin when opening the console websocket (the node checks it). */
  origin: string;
  /** Console and download addresses handed out by the panel must be on one of these domains (or below). */
  nodeDomains: string[];
  /** Has Silly Development's free-server endpoint (/server-creation). */
  freeServers: boolean;
  /** Where the owner makes an API key, in a sentence. */
  keyHelp: string;
  /** What a key looks like; checked before it is sent anywhere. */
  keyPattern: RegExp;
}

const BUILT_IN: BotHostProvider[] = [{
  id: "sillydev",
  label: "Silly Development",
  apiUrl: "https://sillydev.co.uk/panel/api/client",
  origin: "https://sillydev.co.uk",
  nodeDomains: ["sillydev.co.uk"],
  freeServers: true,
  keyHelp: "In the Silly Development panel open Account → API keys → Create, choose full access, and copy the key (it starts with sdevc_).",
  keyPattern: /^(sdevc|ptlc)_[A-Za-z0-9]{20,100}$/,
}];

const GENERIC_KEY = /^[A-Za-z0-9_]{20,120}$/;

function isHttps(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try { return new URL(url).protocol === "https:"; } catch { return false; }
}

/** Panels an admin added with BOT_HOST_PANELS. Invalid entries are skipped. */
function fromEnv(): BotHostProvider[] {
  const raw = process.env.BOT_HOST_PANELS?.trim();
  if (!raw) return [];
  let list: unknown;
  try { list = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(list)) return [];
  const out: BotHostProvider[] = [];
  for (const item of list as Record<string, unknown>[]) {
    const id = String(item?.id ?? "");
    const domains = Array.isArray(item?.nodeDomains) ? item.nodeDomains.map(String).filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d)) : [];
    if (!/^[a-z0-9-]{2,32}$/.test(id) || !isHttps(item.apiUrl) || !isHttps(item.origin) || !domains.length) continue;
    out.push({
      id, label: String(item.label ?? id).slice(0, 60), apiUrl: item.apiUrl, origin: item.origin,
      nodeDomains: domains.map((d) => d.toLowerCase()), freeServers: false,
      keyHelp: String(item.keyHelp ?? "Make a client API key in the panel's account settings.").slice(0, 300),
      keyPattern: GENERIC_KEY,
    });
  }
  return out;
}

export function botHostProviders(): BotHostProvider[] {
  const builtIn = new Set(BUILT_IN.map((p) => p.id));
  return [...BUILT_IN, ...fromEnv().filter((p) => !builtIn.has(p.id))];
}

export function botHostProvider(id: string): BotHostProvider | null {
  return botHostProviders().find((p) => p.id === id) ?? null;
}

/** True when `url` uses one of `protocols` and its host is one of `domains` or a subdomain of one. */
export function onDomains(url: string, domains: string[], protocols: string[]): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (!protocols.includes(u.protocol) || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}
