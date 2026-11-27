/**
 * Which of Kojy's tools go with each AI request in a bot's chat.
 *
 * Every tool's description is sent with every step. With all of them (50+)
 * that was ~6,900 tokens before a word of the chat — more than the free Groq
 * lane takes per request (7,500 with the instructions and history), so the
 * owner's requests could never use it. Now a core set always goes, plus the
 * groups the owner's request is about (by its words), plus every tool already
 * used in this request, plus groups Kojy asks for with load_tools. A tool that
 * isn't loaded still runs if the AI calls it anyway.
 * OWNERSHIP: apps/runner/src/agent
 */

import type { ToolSpec } from "./groq.js";

/** Always sent: what almost every request needs. */
export const CORE_TOOLS = new Set([
  "list_files", "read_file", "search_code", "edit_file", "multi_edit", "write_file", "append_file",
  "check_code", "test_in_room", "test_discord", "run_saved_tests", "get_logs", "bot_control",
  "run_command", "run_python", "fetch_url", "propose_plan", "update_todo", "remember", "open_panel",
  "work_log", "search_chat", "load_tools",
]);

export const TOOL_GROUPS: Record<string, { about: string; tools: string[]; words: RegExp }> = {
  code: {
    about: "understand and restructure code: outline_file, find_symbol, inspect_package, rename_symbol, replace_in_files, edit_lines, move_file, delete_file, undo_changes, restore_file, show_changes, format_code",
    tools: ["outline_file", "find_symbol", "inspect_package", "rename_symbol", "replace_in_files", "edit_lines", "move_file", "delete_file", "undo_changes", "restore_file", "show_changes", "format_code"],
    words: /renam|refactor|clean|move|restructur|reorgani|split|undo|revert|restore|put back|outline|where is|which file|delete|remove|tidy|format|rewrite|changes|what changed|worked before|attribute/,
  },
  debug: {
    about: "find bugs: trace_error, show_changes, inspect_package, find_symbol, wait_for_logs",
    tools: ["trace_error", "show_changes", "inspect_package", "find_symbol", "wait_for_logs"],
    words: /error|crash|bug|broke|fail|traceback|exception|doesn.?t work|not work|isn.?t work|stopp|disconnect|offline|fix|wrong|issue|problem|freez|stuck|not respond|isn.?t answer/,
  },
  testing: {
    about: "testing: call_function, run_unit_tests, save_test, test_in_room, test_discord",
    tools: ["call_function", "run_unit_tests", "save_test", "test_in_room", "test_discord"],
    words: /\btests?\b|unit test|try it|check it works|verify/,
  },
  quality: {
    about: "code quality and speed: lint_code, code_metrics, type_check, profile_code, benchmark, bot_resources, format_code, optimize_query",
    tools: ["lint_code", "code_metrics", "type_check", "profile_code", "benchmark", "bot_resources", "format_code", "optimize_query", "outline_file", "find_symbol"],
    words: /slow|fast|speed|perform|optimi|efficien|lag|memory|ram|cpu|quality|review|lint|secur|safe|complex|types?\b|improve|benchmark|profil|upgrade|better|clean|dead code|unused|duplicat|refactor/,
  },
  data: {
    about: "the bot's saved data: query_data, modify_data, optimize_query, room_activity",
    tools: ["query_data", "modify_data", "optimize_query", "room_activity"],
    words: /coin|data|database|player|score|balance|table|sql|leaderboard|stats|reset|give|take away|activity|visitor|tips?\b|gold|how many|who has|top \d|ranking|inventory|wallet/,
  },
  setup: {
    about: "setup, secrets, packages and GitHub: find_env_vars, request_secrets, test_secrets, set_entrypoint, discord_check, add_package, find_emotes, git",
    tools: ["find_env_vars", "request_secrets", "test_secrets", "set_entrypoint", "discord_check", "add_package", "find_emotes", "git"],
    words: /token|secret|key|password|setup|set up|discord|telegram|entrypoint|intent|install|package|librar|requirement|depend|pip|import|new bot|start command|slash|git|commit|push|pull|repo|room id|env/,
  },
  emotes: {
    about: "Highrise emotes: find_emotes",
    tools: ["find_emotes"],
    words: /emote|dance|wave|animation|pose|kiss|hug|clap/,
  },
  web: {
    about: "the web: web_search, http_request, add_package",
    tools: ["web_search", "http_request", "add_package"],
    words: /\bapi\b|http|web|search|docs|documentation|url|website|request|online|internet|google|look up|weather|openai|groq/,
  },
};

export const LOAD_TOOLS_SPEC: ToolSpec = {
  type: "function",
  function: {
    name: "load_tools",
    description: `Load more of your tools for the rest of this request (only some are loaded at a time). Groups: ${Object.entries(TOOL_GROUPS).map(([g, v]) => `${g} (${v.about})`).join("; ")}.`,
    parameters: { type: "object", properties: { groups: { type: "array", items: { type: "string", enum: Object.keys(TOOL_GROUPS) } } }, required: ["groups"] },
  },
};

/** The groups an owner's request is about, from its words. */
export function groupsFor(text: string): string[] {
  const t = text.toLowerCase();
  return Object.entries(TOOL_GROUPS).filter(([, g]) => g.words.test(t)).map(([name]) => name);
}

/**
 * The tools for one step: the core, the groups asked for (by the request's
 * words or load_tools), and every tool already used in this request.
 */
export function selectTools(all: ToolSpec[], groups: Iterable<string>, used: Iterable<string>, skip: string[] = [], explicit: Iterable<string> = []): ToolSpec[] {
  const want = new Set(CORE_TOOLS);
  for (const g of groups) for (const t of TOOL_GROUPS[g]?.tools ?? []) want.add(t);
  for (const t of skip) want.delete(t);
  // Tools already used, and groups Kojy loaded itself, come whatever the kind of bot.
  for (const g of explicit) for (const t of TOOL_GROUPS[g]?.tools ?? []) want.add(t);
  for (const t of used) want.add(t);
  const picked = all.filter((t) => want.has(t.function.name));
  return picked.some((t) => t.function.name === "load_tools") ? picked : [...picked, LOAD_TOOLS_SPEC];
}

/** load_tools' answer: which groups are now loaded, and their tools. */
export function loadToolsResult(args: Record<string, unknown>, loaded: Set<string>): { ok: boolean; output: string; summary: string } {
  const asked = (Array.isArray(args.groups) ? args.groups : [args.groups]).map(String).filter((g) => g in TOOL_GROUPS);
  if (!asked.length) return { ok: false, output: `Name one or more groups: ${Object.keys(TOOL_GROUPS).join(", ")}.`, summary: "No tool group named" };
  for (const g of asked) loaded.add(g);
  return {
    ok: true,
    output: `Loaded for the rest of this request: ${asked.map((g) => `${g} (${TOOL_GROUPS[g]!.tools.join(", ")})`).join("; ")}. Call them now.`,
    summary: `Loaded tools: ${asked.join(", ")}`,
  };
}
