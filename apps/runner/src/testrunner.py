"""run_unit_tests: runs a bot's own unit tests.

With pytest installed in the bot's environment, pytest runs them. Without it,
a small built-in runner does: test_*.py / *_test.py files, their test_*
functions (async ones too) and unittest.TestCase classes, plain assert.
Tests that need pytest fixtures are reported as skipped.

  testrunner.py [path-or-folder] [-k word]

Prints one line per test (PASS/FAIL/SKIP name), the failures' tracebacks
(the test's own frames only), then a "RESULT passed failed skipped" line.
OWNERSHIP: apps/runner/src
"""

import asyncio
import importlib.util
import inspect
import os
import sys
import traceback
import unittest

SKIP_DIRS = {"venv", ".venv", "data", "node_modules", "__pycache__", ".git", "site-packages"}


def find_tests(target):
    if os.path.isfile(target):
        return [target]
    out = []
    for base, dirs, files in os.walk(target):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not d.startswith("."))
        for f in sorted(files):
            if f.endswith(".py") and (f.startswith("test_") or f.endswith("_test.py")):
                out.append(os.path.relpath(os.path.join(base, f)))
    return out[:60]


def short_tb(exc):
    frames = [f for f in traceback.extract_tb(exc.__traceback__) if "testrunner.py" not in f.filename and "/unittest/" not in f.filename]
    lines = [f'  File "{os.path.relpath(f.filename)}", line {f.lineno}, in {f.name}\n    {f.line}' for f in frames[-6:]]
    msg = "".join(traceback.format_exception_only(type(exc), exc)).strip()
    if isinstance(exc, AssertionError) and not str(exc) and frames:
        msg = f"AssertionError: assert failed: {frames[-1].line}"
    return "\n".join(lines + [msg])


def call(fn):
    result = fn()
    if inspect.isawaitable(result):
        asyncio.run(result)


def main():
    args = sys.argv[1:]
    word = None
    if "-k" in args:
        i = args.index("-k")
        word = args[i + 1] if i + 1 < len(args) else None
        args = args[:i] + args[i + 2:]
    target = args[0] if args else "."
    sys.path.insert(0, os.getcwd())
    files = find_tests(target)
    if not files:
        print("NO_TESTS")
        return
    passed = failed = skipped = 0
    failures = []
    for rel in files:
        name = os.path.splitext(rel)[0].replace(os.sep, ".")
        sys.path.insert(0, os.path.dirname(os.path.abspath(rel)))
        try:
            spec = importlib.util.spec_from_file_location(name, rel)
            mod = importlib.util.module_from_spec(spec)
            sys.modules[name] = mod
            spec.loader.exec_module(mod)
        except BaseException as e:  # a test file that doesn't import
            failed += 1
            print(f"FAIL {rel} (didn't load)")
            failures.append((rel, short_tb(e)))
            continue
        cases = []
        for attr, obj in vars(mod).items():
            if attr.startswith("test") and inspect.isfunction(obj) and obj.__module__ == mod.__name__:
                cases.append((f"{rel}::{attr}", obj, None))
            elif inspect.isclass(obj) and issubclass(obj, unittest.TestCase) and obj.__module__ == mod.__name__:
                for m in unittest.TestLoader().getTestCaseNames(obj):
                    cases.append((f"{rel}::{attr}.{m}", None, obj(m)))
        for label, fn, case in cases:
            if word and word.lower() not in label.lower():
                continue
            if fn is not None and inspect.signature(fn).parameters:
                skipped += 1
                print(f"SKIP {label} (uses pytest fixtures: add pytest to requirements.txt to run it)")
                continue
            try:
                if case is not None:
                    res = unittest.TestResult()
                    case.run(res)
                    problems = res.failures + res.errors
                    if res.skipped:
                        skipped += 1
                        print(f"SKIP {label}")
                        continue
                    if problems:
                        raise AssertionError(problems[0][1].strip().split("\n")[-1])
                else:
                    call(fn)
                passed += 1
                print(f"PASS {label}")
            except unittest.SkipTest as e:
                skipped += 1
                print(f"SKIP {label} ({e})")
            except BaseException as e:
                failed += 1
                print(f"FAIL {label}")
                failures.append((label, short_tb(e)))
    for label, tb in failures[:15]:
        print(f"\n── {label} ──\n{tb}")
    print(f"\nRESULT {passed} {failed} {skipped}")


if __name__ == "__main__":
    main()
