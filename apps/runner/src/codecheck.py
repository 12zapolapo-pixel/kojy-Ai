"""Finds imports in a KojyAI project that nothing installed provides.

Run by the runner for check_code, in a copy of the project, with the bot's
own virtualenv and user:
    python codecheck.py

Prints one line per missing top-level module:
    MISSING <module>|<file>:<line>

Only reads the code (ast); nothing is imported or run. Skipped: the
standard library, the project's own modules and packages, relative imports,
and imports inside `try: ... except ImportError` (optional dependencies).
"""

from __future__ import annotations

import ast
import importlib.util
import os
import sys

SKIP_DIRS = {".git", "node_modules", "__pycache__", "venv", ".venv", "data", "env"}
OPTIONAL = {"ImportError", "ModuleNotFoundError", "Exception", "BaseException"}


def local_modules(root: str) -> set[str]:
    names = set()
    for entry in os.listdir(root):
        if entry.endswith(".py"):
            names.add(entry[:-3])
        elif os.path.isdir(os.path.join(root, entry)) and not entry.startswith("."):
            names.add(entry)
    return names


def handles_import_errors(node: ast.Try) -> bool:
    for h in node.handlers:
        if h.type is None:
            return True
        types = h.type.elts if isinstance(h.type, ast.Tuple) else [h.type]
        for t in types:
            name = t.id if isinstance(t, ast.Name) else t.attr if isinstance(t, ast.Attribute) else ""
            if name in OPTIONAL:
                return True
    return False


def imports(tree: ast.AST):
    """(module, line) for every import outside an ImportError guard."""
    def walk(node, guarded):
        if isinstance(node, ast.Try) and handles_import_errors(node):
            for child in node.body:
                yield from walk(child, True)
            for part in (node.handlers, node.orelse, node.finalbody):
                for child in part:
                    yield from walk(child, guarded)
            return
        if not guarded:
            if isinstance(node, ast.Import):
                for alias in node.names:
                    yield alias.name.split(".")[0], node.lineno
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                yield node.module.split(".")[0], node.lineno
        for child in ast.iter_child_nodes(node):
            yield from walk(child, guarded)

    yield from walk(tree, False)


def main() -> None:
    root = os.getcwd()
    sys.path.insert(0, root)
    local = local_modules(root)
    stdlib = set(getattr(sys, "stdlib_module_names", ())) | set(sys.builtin_module_names)
    seen = set()
    for folder, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
        for name in files:
            if not name.endswith(".py"):
                continue
            path = os.path.join(folder, name)
            rel = os.path.relpath(path, root)
            try:
                with open(path, encoding="utf-8") as f:
                    tree = ast.parse(f.read(), rel)
            except (SyntaxError, UnicodeDecodeError, OSError):
                continue  # compileall reports these
            here = local_modules(folder)
            for module, line in imports(tree):
                if module in seen or module in stdlib or module in local or module in here or module == "__future__":
                    continue
                try:
                    found = importlib.util.find_spec(module) is not None
                except (ImportError, ValueError):
                    found = False
                if not found:
                    seen.add(module)
                    print(f"MISSING {module}|{rel}:{line}", flush=True)


if __name__ == "__main__":
    main()
