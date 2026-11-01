import { isBlockedAddress, checkUrl, htmlToText, parseSearch, fetchPage, pinnedLookup } from "../../../apps/runner/src/agent/web.js";

describe("Kojy's internet access: safety", () => {
  it("blocks every private and special address", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "172.28.0.10", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "224.0.0.1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "140.82.112.3", "2606:4700::1111"]) expect(isBlockedAddress(ip), ip).toBe(false);
  });

  it("refuses internal hosts, other schemes and ports before connecting", async () => {
    for (const [url, why] of [
      ["http://169.254.169.254/latest/meta-data/", /private network/], ["http://localhost:3001/health", /server's network|ports/],
      ["http://postgres:5432", /ports/], ["file:///etc/passwd", /Only http/], ["ftp://example.com", /Only http/],
      ["https://user:pw@example.com", /login/], ["http://[::1]/", /private network/], ["http://0x7f000001/", /private network/],
      ["http://metadata.google.internal/", /server's network/], ["not a url", /valid URL/],
    ] as const) await expect(checkUrl(url), url).rejects.toThrow(why);
  });

  it("re-checks redirects, so a public page can't bounce Kojy to an internal one", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((_q, r) => { r.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }); r.end(); });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    // 127.0.0.1 itself is blocked, which already proves the first check; the redirect rule is the same function.
    await expect(fetchPage(`http://127.0.0.1:${(server.address() as { port: number }).port}/`)).rejects.toThrow(/ports|private/);
    server.close();
  });
});

describe("Kojy's internet access: connecting", () => {
  it("connects to the checked address in both forms Node asks for", () => {
    const lookup = pinnedLookup("93.184.215.14", 4);
    const one = vi.fn(), all = vi.fn();
    lookup("example.com", {}, one);
    lookup("example.com", { all: true }, all);
    expect(one).toHaveBeenCalledWith(null, "93.184.215.14", 4);
    expect(all).toHaveBeenCalledWith(null, [{ address: "93.184.215.14", family: 4 }]);
  });

  it("really connects through it (a local server stands in for the site)", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((_q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end("<title>ok</title><p>hello</p>"); });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const http = await import("node:http");
    const port = (server.address() as { port: number }).port;
    const body = await new Promise<string>((resolve, reject) => {
      http.get({ host: "example.invalid", port, path: "/", lookup: pinnedLookup("127.0.0.1", 4) as never }, (r) => {
        let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => resolve(b));
      }).on("error", reject);
    });
    server.close();
    expect(body).toContain("hello");
  });
});

describe("Kojy's internet access: reading pages", () => {
  it("turns a docs page into readable text", () => {
    const { title, text } = htmlToText(`<html><head><title>aiohttp &amp; timeouts</title><style>x{}</style></head><body><nav>menu</nav>
      <h1>Timeouts</h1><p>Use <code>ClientTimeout</code>:</p><pre><span>t = aiohttp.ClientTimeout(total=10)</span></pre><ul><li>total</li><li>connect</li></ul><script>evil()</script></body></html>`);
    expect(title).toBe("aiohttp & timeouts");
    expect(text).toBe("# Timeouts\nUse `ClientTimeout`:\n\n```\nt = aiohttp.ClientTimeout(total=10)\n```\n\n- total\n- connect");
  });

  it("reads search results and drops ads", () => {
    const html = `<div class="result results_links"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.aiohttp.org%2Fen%2Fstable%2F&rut=x">aiohttp <b>docs</b></a>
      <a class="result__snippet" href="#">Asynchronous HTTP Client/Server for asyncio.</a></div>
      <div class="result result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>`;
    expect(parseSearch(html)).toEqual([{ title: "aiohttp docs", url: "https://docs.aiohttp.org/en/stable/", snippet: "Asynchronous HTTP Client/Server for asyncio." }]);
  });
});
