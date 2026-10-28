#!/usr/bin/env python3
"""
Highrise Bot Code Validator — real AST-based structural analysis.

Reads a JSON payload from stdin: {"code": str, "expected_handlers": [str],
"expected_commands": [str]}. Writes a JSON result to stdout:
{"syntax_valid": bool, "syntax_error": str|null, "found_handlers": [str],
"missing_handlers": [str], "found_commands": [str], "missing_commands": [str]}

This is a genuine improvement over substring text-matching:
- ast.parse() catches REAL Python syntax errors (unbalanced brackets, bad
  indentation, invalid syntax) — a substring check on raw text cannot detect
  any of these; a file with a syntax error would still "pass" a text search.
- Handler detection walks actual FunctionDef/AsyncFunctionDef nodes and
  checks the function name — not "does this word appear anywhere in the
  file" (which would false-positive on a comment, a docstring, or an
  unrelated variable name containing the same substring).
- Command detection looks for the command string as an actual ast.Constant
  string node in the source (e.g. in an `if message == "!wave":` comparison
  or `.startswith("!wave")` call) rather than a raw substring anywhere.

This does NOT execute the generated code — no imports are resolved, no
functions are called. It is pure static analysis via Python's own parser,
so it carries none of the arbitrary-code-execution risk that actually
running untrusted LLM-generated code would. Genuine behavioral testing
(calling handlers with synthetic events) requires real process isolation
(the highrise-sandbox MCP / Docker path this project's own comments
describe as the production target) and should not be built as an
unsandboxed shortcut.
"""

import ast
import json
import sys


def find_defined_function_names(tree: ast.AST) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            names.add(node.name)
    return names


def find_string_constants(tree: ast.AST) -> set[str]:
    values: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            values.add(node.value)
    return values


def main() -> None:
    payload = json.load(sys.stdin)
    code: str = payload.get("code", "")
    expected_handlers: list[str] = payload.get("expected_handlers", [])
    expected_commands: list[str] = payload.get("expected_commands", [])

    result = {
        "syntax_valid": True,
        "syntax_error": None,
        "found_handlers": [],
        "missing_handlers": [],
        "found_commands": [],
        "missing_commands": [],
    }

    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        result["syntax_valid"] = False
        result["syntax_error"] = f"Line {e.lineno}: {e.msg}"
        result["missing_handlers"] = expected_handlers
        result["missing_commands"] = expected_commands
        print(json.dumps(result))
        return
    except Exception as e:  # noqa: BLE001 — surface any parse failure, not just SyntaxError
        result["syntax_valid"] = False
        result["syntax_error"] = f"{type(e).__name__}: {e}"
        result["missing_handlers"] = expected_handlers
        result["missing_commands"] = expected_commands
        print(json.dumps(result))
        return

    defined_functions = find_defined_function_names(tree)
    string_literals    = find_string_constants(tree)

    for handler in expected_handlers:
        if handler in defined_functions:
            result["found_handlers"].append(handler)
        else:
            result["missing_handlers"].append(handler)

    for command in expected_commands:
        # A command is considered "handled" if its literal string appears as
        # an actual string constant somewhere in the parsed source — this
        # covers both `== "!wave"` and `.startswith("!wave")` patterns
        # without requiring us to know the exact comparison style the LLM
        # chose, while still being a real AST-node check, not a raw substring
        # scan of the whole file text.
        if any(command in literal for literal in string_literals):
            result["found_commands"].append(command)
        else:
            result["missing_commands"].append(command)

    print(json.dumps(result))


if __name__ == "__main__":
    main()
