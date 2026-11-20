/**
 * Missing packages — when a bot fails to load because it imports a package
 * that isn't installed, KojyAI adds it to requirements.txt itself and starts
 * the bot again (the next start installs it). No AI is involved.
 * OWNERSHIP: apps/runner
 *
 * Only well-known packages, by the name the code imports: installing a
 * package runs its author's code, and a name that's slightly off (a typo in
 * the import) can belong to someone else entirely. A name not listed here is
 * left to the owner, with a note saying which import failed.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { projectDir } from "@kojyai/shared/projects";

/** import name → the package that provides it on PyPI. */
export const KNOWN_PACKAGES: Readonly<Record<string, string>> = {
  aiohttp: "aiohttp", aiofiles: "aiofiles", aiosqlite: "aiosqlite", anthropic: "anthropic", apscheduler: "APScheduler",
  asyncpg: "asyncpg", bs4: "beautifulsoup4", cachetools: "cachetools", certifi: "certifi", colorama: "colorama",
  cohere: "cohere", cv2: "opencv-python", dateutil: "python-dateutil", deep_translator: "deep-translator",
  discord: "discord.py", dotenv: "python-dotenv", emoji: "emoji", fastapi: "fastapi", firebase_admin: "firebase-admin",
  flask: "Flask", fuzzywuzzy: "fuzzywuzzy", google_generativeai: "google-generativeai", googletrans: "googletrans",
  groq: "groq", gspread: "gspread", gtts: "gTTS", httpx: "httpx", jwt: "PyJWT", langdetect: "langdetect",
  Levenshtein: "python-Levenshtein", matplotlib: "matplotlib", mistralai: "mistralai", motor: "motor", nacl: "PyNaCl",
  numpy: "numpy", openai: "openai", orjson: "orjson", pandas: "pandas", PIL: "Pillow", praw: "praw",
  psycopg2: "psycopg2-binary", pydantic: "pydantic", pymongo: "pymongo", pytz: "pytz", rapidfuzz: "rapidfuzz",
  redis: "redis", replicate: "replicate", requests: "requests", rich: "rich", schedule: "schedule",
  spotipy: "spotipy", sqlalchemy: "SQLAlchemy", supabase: "supabase", telegram: "python-telegram-bot",
  tenacity: "tenacity", tqdm: "tqdm", tweepy: "tweepy", ujson: "ujson", uvicorn: "uvicorn", websockets: "websockets",
  wikipedia: "wikipedia", yaml: "PyYAML", yt_dlp: "yt-dlp", zoneinfo: "tzdata",
};

/** The package to install for a missing import (by its top-level name), or null when it isn't a well-known one. */
export function packageFor(module: string): string | null {
  const top = module.split(".")[0] ?? "";
  if (top === "google" && /^google\.generativeai\b/.test(module)) return KNOWN_PACKAGES.google_generativeai!;
  return Object.prototype.hasOwnProperty.call(KNOWN_PACKAGES, top) ? KNOWN_PACKAGES[top]! : null;
}

/** Whether `module` is one of the bot's own files or folders (a wrong import path, not a missing package). */
export function isLocalModule(uuid: string, module: string): boolean {
  const top = module.split(".")[0] ?? "";
  if (!/^[A-Za-z_]\w*$/.test(top)) return false;
  const dir = projectDir(uuid);
  return existsSync(path.join(dir, `${top}.py`)) || existsSync(path.join(dir, top));
}

const requirementName = (line: string) => line.split("#")[0]!.trim().split(/[\s<>=!~;[]/)[0]!.toLowerCase().replace(/_/g, "-");

/** Whether requirements.txt already asks for this package. */
export function hasRequirement(uuid: string, pipName: string): boolean {
  const file = path.join(projectDir(uuid), "requirements.txt");
  if (!existsSync(file)) return false;
  const want = pipName.toLowerCase().replace(/_/g, "-");
  return readFileSync(file, "utf8").split(/\r?\n/).some((l) => requirementName(l) === want);
}

/** Adds a package to requirements.txt (creating it when there's none). */
export function addRequirement(uuid: string, pipName: string): void {
  const file = path.join(projectDir(uuid), "requirements.txt");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  writeFileSync(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${pipName}\n`);
}
