#!/usr/bin/env node
/**
 * Builds a Node service (apps/api, apps/worker) into one ESM file.
 *
 *   node ../../scripts/build-server.mjs src/boot.ts dist/boot.js [--copy <from>=<to>]...
 *
 * --copy copies a file or folder into the build output (e.g. SQL migrations).
 *
 * Workspace packages (@kojyai/*) export raw TypeScript, which Node can't run
 * in production, so their code is bundled in. Every npm package stays
 * external and is loaded from the app's own node_modules at runtime — native
 * addons (isolated-vm), BullMQ's Lua scripts and pino's worker transports all
 * break when bundled. Because of that, each external must be a declared
 * dependency of the app itself (a workspace package's dependency is not
 * installed next to the app by `pnpm deploy --prod`); the build fails loudly
 * if one is missing.
 */

import { build } from "esbuild";
import { cpSync, readFileSync, rmSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

const [entry, outfile, ...rest] = process.argv.slice(2);
if (!entry || !outfile) {
  console.error("usage: build-server.mjs <entry.ts> <outfile.js> [--copy <from>=<to>]...");
  process.exit(2);
}
const copies = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] !== "--copy" || !rest[i + 1]?.includes("=")) {
    console.error(`unexpected argument: ${rest[i]}`);
    process.exit(2);
  }
  copies.push(rest[++i].split("="));
}

const appDir = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(appDir, "package.json"), "utf8"));
const declared = new Set(Object.keys(pkg.dependencies ?? {}));
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
const externals = new Set();

/** "pino-pretty/lib/x" -> "pino-pretty", "@scope/name/x" -> "@scope/name" */
const packageName = (spec) => spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");

const externalizeNpm = {
  name: "externalize-npm",
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith("@kojyai/") || args.path.startsWith("node:") || builtins.has(args.path)) return undefined;
      externals.add(packageName(args.path));
      return { path: args.path, external: true };
    });
  },
};

rmSync(path.dirname(path.resolve(appDir, outfile)), { recursive: true, force: true });

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  logLevel: "warning",
  plugins: [externalizeNpm],
  // Bundled code may still reach for require()/__dirname (CJS habits in deps
  // we inline); give the ESM output real ones.
  banner: {
    js: [
      'import { createRequire as __kojyCreateRequire } from "node:module";',
      'import { fileURLToPath as __kojyFileURLToPath } from "node:url";',
      'import { dirname as __kojyDirname } from "node:path";',
      "const require = __kojyCreateRequire(import.meta.url);",
      "const __filename = __kojyFileURLToPath(import.meta.url);",
      "const __dirname = __kojyDirname(__filename);",
    ].join("\n"),
  },
});

const missing = [...externals].filter((name) => !declared.has(name)).sort();
if (missing.length > 0) {
  console.error(
    `\n${pkg.name}: the bundle imports npm packages that are not in its own "dependencies":\n` +
    missing.map((m) => `  - ${m}`).join("\n") +
    "\nAdd them to package.json, otherwise a production install won't contain them.\n",
  );
  process.exit(1);
}
for (const [from, to] of copies) cpSync(from, to, { recursive: true });
console.log(`${pkg.name}: built ${outfile} (${externals.size} external packages)`);
