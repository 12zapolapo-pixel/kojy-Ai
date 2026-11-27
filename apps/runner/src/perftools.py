"""Kojy's speed tools, run in the bot's own environment and folder.

  perftools.py profile '<json>'     {"module","function","args","kwargs"} or {"code"}: where the time and
                                    memory go (cProfile + tracemalloc); for async code also every callback
                                    that blocked the event loop (asyncio debug mode)
  perftools.py benchmark '<json>'   {"code","baseline"?,"setup"?,"seconds"?}: time per run of each version,
                                    the speedup, and whether both leave the same `result`

Prints plain text for the model.
OWNERSHIP: apps/runner/src
"""

import asyncio
import cProfile
import importlib
import inspect
import io
import json
import logging
import os
import pstats
import statistics
import sys
import time
import tracemalloc
import contextlib
import sysconfig

ROOT = os.getcwd()
STDLIB = sysconfig.get_paths()["stdlib"]
sys.path.insert(0, ROOT)


def fmt_time(s):
    if s >= 1:
        return f"{s:.2f} s"
    if s >= 1e-3:
        return f"{s * 1e3:.2f} ms"
    return f"{s * 1e6:.1f} µs"


def fmt_bytes(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024


class SlowCallbacks(logging.Handler):
    """asyncio's debug mode logs 'Executing <…> took 0.250 seconds' for each callback that blocked the loop."""

    def __init__(self):
        super().__init__(logging.WARNING)
        self.seen = []

    def emit(self, record):
        msg = record.getMessage()
        if "took" in msg and "seconds" in msg:
            self.seen.append(msg[:300])


def target_of(spec):
    if spec.get("code"):
        code = spec["code"]
        if "await " in code:
            src = "async def __kojy_main__():\n" + "\n".join("    " + l for l in code.split("\n"))
            ns = {}
            exec(compile(src, "<snippet>", "exec"), ns)
            return ns["__kojy_main__"], "the snippet"
        compiled = compile(code, "<snippet>", "exec")
        return (lambda: exec(compiled, {"__name__": "__kojy__"})), "the snippet"
    mod = importlib.import_module(spec["module"])
    obj = mod
    for part in spec["function"].split("."):
        obj = getattr(obj, part)
    args, kwargs = spec.get("args") or [], spec.get("kwargs") or {}
    return (lambda: obj(*args, **kwargs)), f"{spec['module']}.{spec['function']}()"


def run_maybe_async(fn, slow):
    result = fn()
    if inspect.isawaitable(result):
        async def wait():
            loop = asyncio.get_running_loop()
            loop.slow_callback_duration = 0.05
            return await result
        logging.getLogger("asyncio").addHandler(slow)
        return asyncio.run(wait(), debug=True)
    return result


def profile(spec):
    fn, label = target_of(spec)
    slow = SlowCallbacks()
    prof = cProfile.Profile()
    out = io.StringIO()
    tracemalloc.start()
    started = time.perf_counter()
    error = None
    with contextlib.redirect_stdout(out):
        prof.enable()
        try:
            run_maybe_async(fn, slow)
        except BaseException as e:  # still show where the time went
            error = f"{type(e).__name__}: {e}"
        finally:
            prof.disable()
    took = time.perf_counter() - started
    _, peak = tracemalloc.get_traced_memory()
    snapshot = tracemalloc.take_snapshot()
    tracemalloc.stop()
    print(f"Profiled {label}: {fmt_time(took)} in total, peak memory {fmt_bytes(peak)}")
    if error:
        print(f"It raised {error}")
    stats = pstats.Stats(prof)
    rows = []
    for (file, line, name), (cc, nc, tt, ct, _) in stats.stats.items():
        if "cProfile" in file or "perftools.py" in file or name in ("<built-in method builtins.exec>", "disable") or file.startswith("<frozen"):
            continue
        # Python's own machinery (asyncio's loop, importlib…) only hides what matters; built-ins like time.sleep stay.
        if file.startswith(STDLIB) and "site-packages" not in file:
            continue
        mine = file.startswith(ROOT) and "/venv/" not in file and "site-packages" not in file
        where = os.path.relpath(file, ROOT) if mine else ("builtin" if file == "~" else os.path.basename(file))
        rows.append((ct, tt, nc, f"{where}:{line} {name}" if file != "~" else name, mine))
    rows.sort(key=lambda r: -r[0])
    print("\nSlowest by total time (incl. what they call) — * = the bot's own code:")
    print("   total     own     calls  function")
    for ct, tt, nc, name, mine in rows[:15]:
        print(f"{fmt_time(ct):>9} {fmt_time(tt):>8} {nc:>8}  {'*' if mine else ' '} {name[:110]}")
    own = sorted((r for r in rows if r[4]), key=lambda r: -r[1])[:5]
    if own:
        print("\nWhere the bot's own code spends its time (own time):")
        for ct, tt, nc, name, _ in own:
            print(f"  {fmt_time(tt):>9} in {nc} call{'s' if nc != 1 else ''}: {name[:110]}")
    mem = [s for s in snapshot.statistics("lineno") if s.traceback[0].filename.startswith(ROOT)][:5]
    if mem:
        print("\nMemory still held at the end, by line of the bot's code:")
        for s in mem:
            f = s.traceback[0]
            print(f"  {fmt_bytes(s.size):>9}: {os.path.relpath(f.filename, ROOT)}:{f.lineno}")
    if slow.seen:
        print(f"\nBLOCKED THE EVENT LOOP {len(slow.seen)} time(s) (over 50 ms each; the bot can't answer anyone meanwhile):")
        for m in slow.seen[:8]:
            print(f"  {m}")
        print("Use await asyncio.sleep instead of time.sleep, an async library instead of requests, or asyncio.to_thread for heavy work.")
    printed = out.getvalue()
    if printed:
        print("\nIt printed (last part):\n" + printed[-1500:])


def time_variant(code, setup, budget):
    ns = {"__name__": "__kojy__"}
    exec(compile(setup or "pass", "<setup>", "exec"), ns)
    is_async = "await " in code
    if is_async:
        src = "async def __kojy_run__():\n" + "\n".join("    " + l for l in code.split("\n"))
        exec(compile(src, "<code>", "exec"), ns)
        loop = asyncio.new_event_loop()
        once = lambda: loop.run_until_complete(ns["__kojy_run__"]())
    else:
        compiled = compile(code, "<code>", "exec")
        once = lambda: exec(compiled, ns)
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        once()  # warm up (imports, caches)
        number, start = 1, time.perf_counter()
        while True:  # how many runs fill ~1/5 of the budget per sample
            t = time.perf_counter()
            for _ in range(number):
                once()
            if time.perf_counter() - t >= budget / 25 or number >= 1_000_000:
                break
            number *= 2
        samples = []
        while len(samples) < 5 or (time.perf_counter() - start < budget and len(samples) < 20):
            t = time.perf_counter()
            for _ in range(number):
                once()
            samples.append((time.perf_counter() - t) / number)
            if time.perf_counter() - start > budget * 2:
                break
    if is_async:
        loop.close()
    return {"median": statistics.median(samples), "best": min(samples), "runs": number * len(samples), "result": ns.get("result", None), "has_result": "result" in ns}


def benchmark(spec):
    budget = min(max(float(spec.get("seconds") or 2), 0.5), 8)
    new = time_variant(spec["code"], spec.get("setup"), budget)
    if not spec.get("baseline"):
        print(f"{fmt_time(new['median'])} per run (best {fmt_time(new['best'])}, {new['runs']} runs)")
        return
    old = time_variant(spec["baseline"], spec.get("setup"), budget)
    ratio = old["median"] / new["median"] if new["median"] else float("inf")
    print(f"baseline: {fmt_time(old['median'])} per run (best {fmt_time(old['best'])}, {old['runs']} runs)")
    print(f"new:      {fmt_time(new['median'])} per run (best {fmt_time(new['best'])}, {new['runs']} runs)")
    if ratio >= 1.05:
        print(f"RESULT: the new version is {ratio:.1f}× faster")
    elif ratio <= 0.95:
        print(f"RESULT: the new version is {1 / ratio:.1f}× SLOWER")
    else:
        print("RESULT: no real difference (within 5%)")
    if old["has_result"] and new["has_result"]:
        same = old["result"] == new["result"]
        print("Same `result` from both: yes" if same else f"Same `result` from both: NO — baseline {repr(old['result'])[:200]}, new {repr(new['result'])[:200]}")


def main():
    mode, spec = sys.argv[1], json.loads(sys.argv[2])
    try:
        (profile if mode == "profile" else benchmark)(spec)
    except BaseException as e:
        print(f"FAILED: {type(e).__name__}: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
