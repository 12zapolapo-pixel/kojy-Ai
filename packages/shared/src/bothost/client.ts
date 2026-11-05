/**
 * Client for a bot host's panel API: the Pterodactyl-style client API, as
 * Silly Development documents it (https://sillydev.co.uk/docs/panel).
 * OWNERSHIP: packages/shared/src/bothost
 *
 * Failures come back as HostApiError carrying the panel's own message, which
 * is fine to show the owner. Busy answers are retried: 429 after its
 * Retry-After (at most 30s, twice), and for reads a 502/503/504 or a dropped
 * connection once. Redirects are refused, and addresses the panel hands out
 * (console socket, downloads) must be on the provider's own domains.
 */

import { onDomains, type BotHostProvider } from "./providers.js";

export class HostApiError extends Error {
  constructor(readonly status: number, message: string, readonly code = "") {
    super(message);
    this.name = "HostApiError";
  }
}

export type PowerSignal = "start" | "stop" | "restart" | "kill";
export type PowerState = "offline" | "starting" | "running" | "stopping";
export const POWER_STATES: readonly PowerState[] = ["offline", "starting", "running", "stopping"];

export interface HostServer {
  /** The 8-character identifier used in API paths. */
  id: string;
  uuid: string;
  name: string;
  node: string;
  memoryMb: number;
  diskMb: number;
  cpuPercent: number;
  dockerImage: string;
  invocation: string;
  installing: boolean;
  suspended: boolean;
  transferring: boolean;
}

export interface HostStartupVariable { name: string; env: string; value: string; defaultValue: string; editable: boolean }
export interface HostStartup {
  variables: HostStartupVariable[];
  /** The startup command with {{VARIABLE}} placeholders. */
  rawCommand: string;
  /** Display name → image. */
  dockerImages: Record<string, string>;
}

export interface FreeServerOptions { limit: number; owned: number; canCreate: boolean; full: boolean; runtimes: string[] }
export interface HostResources { state: PowerState; memoryBytes: number; diskBytes: number; uptimeMs: number }
export interface HostFileEntry { name: string; isFile: boolean; size: number }

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

interface ClientOptions {
  provider: BotHostProvider;
  apiKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

interface RequestOptions {
  query?: Record<string, string>;
  json?: unknown;
  body?: string | Uint8Array;
  /** The answer is the raw body (file contents), not JSON. */
  raw?: boolean;
  timeoutMs?: number;
}

type Attrs = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

function toServer(a: Attrs): HostServer {
  const limits = (a.limits ?? {}) as Attrs;
  const status = str(a.status);
  return {
    id: str(a.identifier), uuid: str(a.uuid), name: str(a.name), node: str(a.node),
    memoryMb: num(limits.memory), diskMb: num(limits.disk), cpuPercent: num(limits.cpu),
    dockerImage: str(a.docker_image), invocation: str(a.invocation),
    installing: a.is_installing === true || status === "installing",
    suspended: a.is_suspended === true || status === "suspended",
    transferring: a.is_transferring === true,
  };
}

function errorFrom(status: number, text: string, label: string): HostApiError {
  let detail = "";
  let code = "";
  try {
    const first = (JSON.parse(text) as { errors?: { code?: string; detail?: string }[] }).errors?.[0];
    detail = str(first?.detail);
    code = str(first?.code);
  } catch { /* not the JSON error format */ }
  const fallback: Record<number, string> = {
    401: `${label} refused the API key (it's wrong, expired or deleted).`,
    403: `The API key isn't allowed to do this on ${label}. Give it full access in the panel.`,
    404: `${label} has no such server, or the API key can't see it.`,
    409: `The server on ${label} is busy (installing, restoring or being changed). Try again in a minute.`,
    429: `${label} asked KojyAI to slow down. Try again in a minute.`,
  };
  return new HostApiError(status, (detail || fallback[status] || `${label} answered with HTTP ${status}.`).slice(0, 500), code);
}

export class BotHostClient {
  readonly provider: BotHostProvider;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(opts: ClientOptions) {
    this.provider = opts.provider;
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private async request(method: "GET" | "POST" | "PUT" | "DELETE", path: string, opts: RequestOptions = {}): Promise<unknown> {
    const url = new URL(`${this.provider.apiUrl.replace(/\/$/, "")}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" };
    let body: string | Uint8Array<ArrayBuffer> | undefined;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = typeof opts.body === "string" ? "text/plain" : "application/octet-stream";
      body = typeof opts.body === "string" ? opts.body : new Uint8Array(opts.body); // a copy fetch accepts as a body
    }
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method, headers, body: body ?? null, redirect: "error", signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs) });
      } catch (err) {
        if (method === "GET" && attempt === 1) { await this.sleep(2000); continue; }
        throw new HostApiError(0, `Couldn't reach ${this.provider.label}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (res.status === 429 && attempt <= 2) {
        await res.body?.cancel().catch(() => undefined);
        await this.sleep(Math.min(Math.max(Number(res.headers.get("retry-after")) || 5, 1), 30) * 1000);
        continue;
      }
      if (method === "GET" && attempt === 1 && (res.status === 502 || res.status === 503 || res.status === 504)) {
        await res.body?.cancel().catch(() => undefined);
        await this.sleep(2000);
        continue;
      }
      const text = res.status === 204 ? "" : await res.text();
      if (!res.ok) throw errorFrom(res.status, text, this.provider.label);
      if (opts.raw) return text;
      if (!text) return undefined;
      try { return JSON.parse(text) as unknown; } catch { return text; }
    }
  }

  private server(id: string): string {
    if (!/^[A-Za-z0-9-]{4,64}$/.test(id)) throw new HostApiError(400, `Not a server identifier: ${id}`);
    return `/servers/${id}`;
  }

  // ── account and servers ────────────────────────────────────────────────────

  async account(): Promise<{ username: string; email: string }> {
    const a = ((await this.request("GET", "/account")) as { attributes?: Attrs })?.attributes ?? {};
    return { username: str(a.username), email: str(a.email) };
  }

  async listServers(): Promise<HostServer[]> {
    const out: HostServer[] = [];
    for (let page = 1; page <= 5; page++) {
      const r = (await this.request("GET", "/", { query: { page: String(page) } })) as { data?: { attributes?: Attrs }[]; meta?: { pagination?: { total_pages?: number } } };
      for (const item of r?.data ?? []) if (item.attributes) out.push(toServer(item.attributes));
      if (page >= num(r?.meta?.pagination?.total_pages)) break;
    }
    return out;
  }

  async getServer(id: string): Promise<HostServer> {
    const r = (await this.request("GET", this.server(id))) as { attributes?: Attrs };
    if (!r?.attributes) throw new HostApiError(502, `${this.provider.label} sent an unexpected answer about the server.`);
    return toServer(r.attributes);
  }

  /** How many free servers the account may make (Silly Development); null where the panel has no such thing. */
  async freeServerOptions(): Promise<FreeServerOptions | null> {
    if (!this.provider.freeServers) return null;
    try {
      const a = ((await this.request("GET", "/server-creation")) as { attributes?: Attrs })?.attributes ?? {};
      const runtimes = Array.isArray(a.runtimes) ? (a.runtimes as Attrs[]).map((r) => str(r.key)).filter(Boolean) : [];
      return { limit: num(a.limit), owned: num(a.servers_owned), canCreate: a.can_create === true, full: a.free_full === true, runtimes };
    } catch (err) {
      if (err instanceof HostApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** A new free server. It is still installing when this returns: wait until getServer says it isn't. */
  async createFreeServer(input: { name: string; description: string; runtime: string }): Promise<HostServer> {
    const r = (await this.request("POST", "/server-creation", { json: input, timeoutMs: 60_000 })) as { attributes?: Attrs };
    if (!r?.attributes) throw new HostApiError(502, `${this.provider.label} didn't say which server it made.`);
    return toServer(r.attributes);
  }

  async resources(id: string): Promise<HostResources> {
    const a = ((await this.request("GET", `${this.server(id)}/resources`)) as { attributes?: Attrs })?.attributes ?? {};
    const res = (a.resources ?? {}) as Attrs;
    const state = str(a.current_state) as PowerState;
    return { state: POWER_STATES.includes(state) ? state : "offline", memoryBytes: num(res.memory_bytes), diskBytes: num(res.disk_bytes), uptimeMs: num(res.uptime) };
  }

  async power(id: string, signal: PowerSignal): Promise<void> {
    await this.request("POST", `${this.server(id)}/power`, { json: { signal } });
  }

  async command(id: string, command: string): Promise<void> {
    await this.request("POST", `${this.server(id)}/command`, { json: { command } });
  }

  // ── startup ────────────────────────────────────────────────────────────────

  async startup(id: string): Promise<HostStartup> {
    const r = (await this.request("GET", `${this.server(id)}/startup`)) as { data?: { attributes?: Attrs }[]; meta?: Attrs };
    const variables = (r?.data ?? []).map((d) => d.attributes ?? {}).map((a) => ({
      name: str(a.name), env: str(a.env_variable), value: str(a.server_value), defaultValue: str(a.default_value), editable: a.is_editable === true,
    }));
    const images = r?.meta?.docker_images;
    return {
      variables,
      rawCommand: str(r?.meta?.raw_startup_command),
      dockerImages: images && typeof images === "object" ? Object.fromEntries(Object.entries(images as Attrs).map(([k, v]) => [k, str(v)])) : {},
    };
  }

  async setStartupVariable(id: string, key: string, value: string): Promise<void> {
    await this.request("PUT", `${this.server(id)}/startup/variable`, { json: { key, value } });
  }

  /** One of the images the startup settings offer (a Python version); used from the next start. */
  async setDockerImage(id: string, image: string): Promise<void> {
    await this.request("PUT", `${this.server(id)}/settings/docker-image`, { json: { docker_image: image } });
  }

  // ── files ──────────────────────────────────────────────────────────────────

  async listDir(id: string, directory = "/"): Promise<HostFileEntry[]> {
    const r = (await this.request("GET", `${this.server(id)}/files/list`, { query: { directory } })) as { data?: { attributes?: Attrs }[] };
    return (r?.data ?? []).map((d) => d.attributes ?? {}).map((a) => ({ name: str(a.name), isFile: a.is_file === true, size: num(a.size) }));
  }

  async readFile(id: string, file: string): Promise<string> {
    return str(await this.request("GET", `${this.server(id)}/files/contents`, { query: { file }, raw: true }));
  }

  /** Creates or replaces a file (missing folders are made). */
  async writeFile(id: string, file: string, content: string | Uint8Array): Promise<void> {
    await this.request("POST", `${this.server(id)}/files/write`, { query: { file }, body: content, timeoutMs: 120_000 });
  }

  async deleteFiles(id: string, files: string[], root = "/"): Promise<void> {
    if (!files.length) return;
    await this.request("POST", `${this.server(id)}/files/delete`, { json: { root, files } });
  }

  /** A file's bytes, through the one-time download link the panel signs on the server's node. */
  async downloadFile(id: string, file: string): Promise<Uint8Array> {
    const r = (await this.request("GET", `${this.server(id)}/files/download`, { query: { file } })) as { attributes?: Attrs };
    const url = str(r?.attributes?.url);
    if (!onDomains(url, this.provider.nodeDomains, ["https:"])) throw new HostApiError(502, `${this.provider.label} gave a download address outside its own servers.`);
    const res = await this.fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new HostApiError(res.status, `Downloading ${file} from ${this.provider.label} failed (HTTP ${res.status}).`);
    const size = Number(res.headers.get("content-length"));
    if (size > MAX_DOWNLOAD_BYTES) throw new HostApiError(413, `${file} is too big to copy back (${Math.round(size / 1048576)} MB).`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_DOWNLOAD_BYTES) throw new HostApiError(413, `${file} is too big to copy back.`);
    return buf;
  }

  // ── live console ───────────────────────────────────────────────────────────

  /** A 10-minute token and the node's console socket. The panel allows 5 of these a minute per server. */
  async consoleCredentials(id: string): Promise<{ token: string; socket: string }> {
    const d = ((await this.request("GET", `${this.server(id)}/websocket`)) as { data?: Attrs })?.data ?? {};
    const token = str(d.token);
    const socket = str(d.socket);
    if (!token || !onDomains(socket, this.provider.nodeDomains, ["wss:"])) {
      throw new HostApiError(502, `${this.provider.label} gave a console address outside its own servers.`);
    }
    return { token, socket };
  }
}

/**
 * The startup variable holding the Python file the server runs: one the
 * startup command uses, that the owner may change, and whose value (or
 * default) is a .py file — or failing that, one named like a main/bot file.
 */
export function pythonFileVariable(startup: HostStartup): string | null {
  const used = new Set([
    ...[...startup.rawCommand.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]!),
    ...[...startup.rawCommand.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)].map((m) => m[1]!),
  ]);
  const editable = startup.variables.filter((v) => v.editable && v.env && (used.size === 0 || used.has(v.env)));
  return editable.find((v) => /\.py$/i.test(v.value || v.defaultValue))?.env
    ?? editable.find((v) => /(PY|MAIN|BOT|STARTUP)_?FILE/i.test(v.env))?.env
    ?? null;
}
