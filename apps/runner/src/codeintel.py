"""Kojy's code intelligence: reads Python with the ast module (nothing runs) or
inspects an installed library's real API.

  codeintel.py outline <file>      classes, functions and methods with line ranges and signatures
  codeintel.py symbol <name>       where a name is defined and where it is used, in every .py file under .
  codeintel.py inspect <target>    the API of a module, class or function (imports it: run in the bot's venv)

Plain text out, one finding per line, so the model can read it directly.
OWNERSHIP: apps/runner/src
"""

import ast
import inspect
import importlib
import os
import sys

SKIP_DIRS = {"venv", ".venv", "data", "node_modules", "__pycache__", ".git", "site-packages"}
MAX_FILES = 400
MAX_LINES = 160


def py_files(root="."):
    n = 0
    for base, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not d.startswith("."))
        for f in sorted(files):
            if f.endswith(".py"):
                p = os.path.join(base, f)
                try:
                    if os.path.getsize(p) > 400_000:
                        continue
                except OSError:
                    continue
                yield os.path.relpath(p, root)
                n += 1
                if n >= MAX_FILES:
                    return


def parse(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
        return ast.parse(text, filename=path), text.split("\n")
    except SyntaxError as e:
        return e, []
    except OSError as e:
        return e, []


def signature(node):
    try:
        args = ast.unparse(node.args)
    except Exception:
        args = "..."
    ret = ""
    if getattr(node, "returns", None) is not None:
        try:
            ret = " -> " + ast.unparse(node.returns)
        except Exception:
            pass
    prefix = "async def" if isinstance(node, ast.AsyncFunctionDef) else "def"
    return f"{prefix} {node.name}({args}){ret}"


def first_doc(node):
    doc = ast.get_docstring(node)
    return doc.strip().split("\n")[0][:100] if doc else ""


def decorators(node):
    out = []
    for d in getattr(node, "decorator_list", []):
        try:
            out.append("@" + ast.unparse(d)[:60])
        except Exception:
            pass
    return out


def outline(path):
    tree, _ = parse(path)
    if isinstance(tree, Exception):
        print(f"Can't read {path}: {tree}")
        return
    lines = []

    def walk(body, indent):
        for node in body:
            if len(lines) >= MAX_LINES:
                return
            if isinstance(node, ast.ClassDef):
                bases = ", ".join(ast.unparse(b) for b in node.bases) if node.bases else ""
                doc = first_doc(node)
                lines.append(f"{'  ' * indent}{node.lineno}-{node.end_lineno} class {node.name}({bases}){'  # ' + doc if doc else ''}")
                walk(node.body, indent + 1)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                deco = " ".join(decorators(node))
                doc = first_doc(node)
                lines.append(f"{'  ' * indent}{node.lineno}-{node.end_lineno} {(deco + ' ') if deco else ''}{signature(node)}{'  # ' + doc if doc else ''}")
            elif indent == 0 and isinstance(node, (ast.Assign, ast.AnnAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                names = [t.id for t in targets if isinstance(t, ast.Name)]
                if names and all(n.isupper() or n[0].isupper() for n in names):
                    lines.append(f"{node.lineno} {', '.join(names)} = ...")
            elif indent == 0 and isinstance(node, (ast.Import, ast.ImportFrom)):
                continue

    walk(tree.body, 0)
    imports = []
    for node in tree.body:
        if isinstance(node, ast.Import):
            imports += [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom):
            imports.append(f"{'.' * node.level}{node.module or ''}: {', '.join(a.name for a in node.names)}")
    total = getattr(tree.body[-1], "end_lineno", 0) if tree.body else 0
    print(f"{path} ({total} lines)")
    if imports:
        print("imports: " + " | ".join(imports)[:600])
    print("\n".join(lines) if lines else "(no classes or functions)")
    if len(lines) >= MAX_LINES:
        print("… more (read the file in parts)")


def symbol(name):
    defs, uses = [], []
    for rel in py_files():
        tree, src = parse(rel)
        if isinstance(tree, Exception):
            continue
        line = lambda n: src[n - 1].strip()[:140] if 0 < n <= len(src) else ""
        parents = {}
        for node in ast.walk(tree):
            for child in ast.iter_child_nodes(node):
                parents[child] = node
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == name:
                owner = parents.get(node)
                where = f" (in class {owner.name})" if isinstance(owner, ast.ClassDef) else ""
                what = signature(node) if not isinstance(node, ast.ClassDef) else f"class {node.name}"
                defs.append(f"{rel}:{node.lineno}-{node.end_lineno}: {what}{where}")
            elif isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                for t in targets:
                    for sub in ast.walk(t):
                        if (isinstance(sub, ast.Name) and sub.id == name) or (isinstance(sub, ast.Attribute) and sub.attr == name):
                            defs.append(f"{rel}:{node.lineno}: assigned: {line(node.lineno)}")
            elif isinstance(node, (ast.Import, ast.ImportFrom)):
                for a in node.names:
                    if (a.asname or a.name.split(".")[-1]) == name or a.name == name:
                        uses.append(f"{rel}:{node.lineno}: imported: {line(node.lineno)}")
            elif isinstance(node, ast.Name) and node.id == name and isinstance(node.ctx, ast.Load):
                uses.append(f"{rel}:{node.lineno}: {line(node.lineno)}")
            elif isinstance(node, ast.Attribute) and node.attr == name and isinstance(node.ctx, ast.Load):
                uses.append(f"{rel}:{node.lineno}: {line(node.lineno)}")
            elif isinstance(node, ast.keyword) and node.arg == name:
                uses.append(f"{rel}:{getattr(node, 'lineno', 0)}: keyword: {line(getattr(node, 'lineno', 0))}")
    defs = list(dict.fromkeys(defs))
    uses = list(dict.fromkeys(uses))
    print(f"Defined ({len(defs)}):")
    print("\n".join(defs[:40]) or "(nowhere in the project's code — maybe it comes from a library: inspect_package)")
    print(f"\nUsed ({len(uses)}):")
    print("\n".join(uses[:80]) or "(nowhere)")
    if len(uses) > 80:
        print(f"… {len(uses) - 80} more")


def describe(obj, name):
    try:
        sig = str(inspect.signature(obj))
    except (TypeError, ValueError):
        sig = ""
    doc = (inspect.getdoc(obj) or "").strip().split("\n")[0][:110]
    kind = "async def" if inspect.iscoroutinefunction(obj) else "class" if inspect.isclass(obj) else "def" if callable(obj) else type(obj).__name__
    return f"{kind} {name}{sig}{'  # ' + doc if doc else ''}"


def inspect_target(target):
    parts = target.split(".")
    obj, mod = None, None
    for i in range(len(parts), 0, -1):
        try:
            mod = importlib.import_module(".".join(parts[:i]))
            obj = mod
            for attr in parts[i:]:
                obj = getattr(obj, attr)
            break
        except ModuleNotFoundError as e:
            tried = ".".join(parts[:i])
            # The module exists but something it imports doesn't: say which.
            if e.name and e.name != tried and not tried.startswith(e.name + "."):
                print(f'Importing {tried} failed: it needs "{e.name}", which isn\'t installed (add its package to requirements.txt and run check_code)')
                return
            continue
        except AttributeError as e:
            print(f"{target}: {e}")
            if mod is not None:
                names = [n for n in dir(mod) if not n.startswith("_")]
                import difflib
                want = parts[-1].lower()
                close = list(dict.fromkeys(difflib.get_close_matches(parts[-1], names, 8, 0.6) + [n for n in names if want in n.lower() or n.lower() in want]))[:20]
                print(f"Names in {mod.__name__} like it: {', '.join(close) or '(none)'}")
            return
        except Exception as e:  # importing ran code that failed
            print(f"Importing {'.'.join(parts[:i])} failed: {type(e).__name__}: {e}")
            return
    if obj is None:
        print(f"No installed module named {parts[0]} (add its package to requirements.txt and run check_code)")
        return
    version = ""
    try:
        from importlib.metadata import version as v, packages_distributions
        dists = packages_distributions().get(parts[0], [])
        if dists:
            version = f" ({dists[0]} {v(dists[0])})"
    except Exception:
        pass
    print(f"{target}{version}")
    src = getattr(obj, "__file__", None) or (inspect.getsourcefile(obj) if not inspect.ismodule(obj) and (inspect.isclass(obj) or inspect.isfunction(obj)) else None)
    if src:
        print(f"source: {src}")
    if inspect.ismodule(obj):
        doc = (inspect.getdoc(obj) or "").strip().split("\n")[0][:200]
        if doc:
            print(doc)
        names = getattr(obj, "__all__", None) or [n for n in dir(obj) if not n.startswith("_")]
        shown = 0
        for n in names:
            try:
                member = getattr(obj, n)
            except Exception:
                continue
            if inspect.ismodule(member):
                print(f"module {n}")
            else:
                print(describe(member, n))
            shown += 1
            if shown >= MAX_LINES:
                print("… more")
                break
    elif inspect.isclass(obj):
        print(describe(obj, obj.__name__))
        print("bases: " + ", ".join(b.__name__ for b in obj.__mro__[1:]))
        shown = 0
        for n, member in inspect.getmembers(obj):
            if n.startswith("_") and n != "__init__":
                continue
            own = next((k for k in obj.__mro__ if n in k.__dict__), obj)
            origin = "" if own is obj else f"  (from {own.__name__})"
            if isinstance(inspect.getattr_static(obj, n, None), property):
                print(f"property {n}{origin}")
            else:
                print(f"  {describe(member, n)}{origin}")
            shown += 1
            if shown >= MAX_LINES:
                print("… more")
                break
    else:
        print(describe(obj, parts[-1]))
        doc = inspect.getdoc(obj) or ""
        if doc:
            print("\n".join(doc.split("\n")[:25]))


def main():
    if len(sys.argv) < 3:
        print("usage: codeintel.py outline|symbol|inspect <arg>")
        sys.exit(2)
    mode, arg = sys.argv[1], sys.argv[2]
    if mode == "outline":
        outline(arg)
    elif mode == "symbol":
        symbol(arg)
    elif mode == "inspect":
        sys.path.insert(0, os.getcwd())
        inspect_target(arg)
    else:
        print(f"unknown mode {mode}")
        sys.exit(2)


if __name__ == "__main__":
    main()
