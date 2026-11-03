"""Checks a KojyAI bot project for check_code: the entrypoint loads, and no
empty placeholder method hides a real one.

Run by the runner in a copy of the project, in its own virtualenv and user:
    python botcheck.py module.path:BotClass

Prints IMPORT_OK when the class loads, then one line per problem:
    HIDDEN <name>|<placeholder class>|<class with the real one>

Why the second check: bots built from mixins often declare the helpers they
use from other mixins as typing placeholders, e.g.

    class TeleportCommandsMixin:
        async def _is_staff(self, user_id: str) -> bool: ...

Python takes the FIRST definition along the class's MRO, so if that mixin is
listed before the one with the real _is_staff, every call gets the
placeholder (which returns None) — the bot runs, and silently treats nobody
as staff. That broke Japalo's staff commands on 2026-11-03.
"""

from __future__ import annotations

import ast
import importlib
import inspect
import sys
import textwrap


def _body(fn) -> list[ast.stmt] | None:
    try:
        node = ast.parse(textwrap.dedent(inspect.getsource(fn))).body[0]
    except (OSError, TypeError, SyntaxError, IndexError):
        return None
    body = getattr(node, "body", None)
    if body is None:
        return None
    # A docstring doesn't count.
    return [b for b in body if not (isinstance(b, ast.Expr) and isinstance(b.value, ast.Constant) and isinstance(b.value.value, str))]


def is_placeholder(fn) -> bool:
    """True for a method whose body is only `...` (the typing-stub idiom)."""
    body = _body(fn)
    return body is not None and len(body) == 1 and isinstance(body[0], ast.Expr) \
        and isinstance(body[0].value, ast.Constant) and body[0].value.value is Ellipsis


def does_something(fn) -> bool:
    """True unless the body is only `...` or `pass` (a no-op hidden by a no-op is harmless)."""
    body = _body(fn)
    if body is None:
        return True  # can't read it: assume it's real
    return not (len(body) == 1 and (isinstance(body[0], ast.Pass) or (
        isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) and body[0].value.value is Ellipsis)))


def _function(attr):
    attr = getattr(attr, "__func__", attr)  # staticmethod / classmethod
    return attr if inspect.isfunction(attr) else None


def hidden_methods(cls: type) -> list[tuple[str, str, str]]:
    """(method, class with the placeholder Python uses, class with the real one it hides)."""
    found = []
    mro = cls.__mro__
    for name in sorted(n for n in dir(cls) if not n.startswith("__")):
        owner = next((c for c in mro if name in c.__dict__), None)
        fn = _function(owner.__dict__[name]) if owner is not None else None
        if fn is None or not is_placeholder(fn):
            continue
        for later in mro[mro.index(owner) + 1:]:
            other = _function(later.__dict__.get(name))
            if other is not None and does_something(other):
                found.append((name, owner.__name__, later.__name__))
                break
    return found


def main() -> None:
    entry = sys.argv[1]
    module_name, class_name = entry.split(":", 1)
    sys.path.insert(0, ".")
    cls = getattr(importlib.import_module(module_name), class_name)
    from highrise import BaseBot

    assert isinstance(cls, type) and issubclass(cls, BaseBot), f"{class_name} is not a BaseBot"
    cls()
    print("IMPORT_OK", flush=True)
    for name, owner, real in hidden_methods(cls):
        print(f"HIDDEN {name}|{owner}|{real}", flush=True)


if __name__ == "__main__":
    main()
