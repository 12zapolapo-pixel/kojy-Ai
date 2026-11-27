"""Kojy's speed tools, run in the bot's own environment, in a copy of its folder.

  perftools.py profile '<json>'     {"module","function","args","kwargs"} or {"code"}, "repeat"?: where the
                                    time and memory go — by function (cProfile), by line of the bot's own code
                                    (CPU sampling), the slow calls into libraries and which bot code made them,
                                    and for async code every callback that blocked the event loop
  perftools.py benchmark '<json>'   {"code","baseline"?,"setup"?,"seconds"?,"sizes"?}: time per run of each
                                    version (samples taken in turns, so drift hits both alike), the speed-up
                                    with its noise, peak memory, whether both leave the same `result`; with
                                    "sizes" the setup sees `n` and the growth (O(n), O(n²)…) is measured

Prints plain text for the model. Works on Python 3.11+.
OWNERSHIP: apps/runner/src
"""

import asyncio
import contextlib
import cProfile
import importlib
import inspect
import io
import json
import logging
import math
import os
import pstats
import signal
import statistics
import sys
import sysconfig
import time
import tracemalloc
from collections import Counter

ROOT = os.getcwd()
STDLIB = sysconfig.get_paths()["stdlib"]
SELF = os.path.abspath(__file__)
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


def is_bot_file(path):
    return path.startswith(ROOT) and "/venv/" not in path and "/.venv/" not in path and "site-packages" not in path and path != SELF


# ── profile ─────────────────────────────────────────────────────────────────


class SlowCallbacks(logging.Handler):
    """asyncio's debug mode logs 'Executing <…> took 0.250 seconds' for each callback that blocked the loop."""

    def __init__(self):
        super().__init__(logging.WARNING)
        self.seen = []

    def emit(self, record):
        msg = record.getMessage()
        if "took" in msg and "seconds" in msg:
            self.seen.append(msg)


class LineSampler:
    """Every 2 ms of CPU time, which line of the bot's own code is running (innermost one)."""

    def __init__(self):
        self.hits = Counter()
        self.total = 0

    def __enter__(self):
        if not hasattr(signal, "setitimer"):
            return self
        signal.signal(signal.SIGPROF, self.sample)
        signal.setitimer(signal.ITIMER_PROF, 0.002, 0.002)
        return self

    def __exit__(self, *exc):
        if hasattr(signal, "setitimer"):
            signal.setitimer(signal.ITIMER_PROF, 0, 0)
            signal.signal(signal.SIGPROF, signal.SIG_DFL)

    def sample(self, _signum, frame):
        self.total += 1
        while frame is not None:
            if is_bot_file(frame.f_code.co_filename):
                self.hits[(frame.f_code.co_filename, frame.f_lineno, frame.f_code.co_name)] += 1
                return
            frame = frame.f_back


def target_of(spec):
    if spec.get("code"):
        code = spec["code"]
        if "await " in code:
            src = "async def __kojy_main__():\n" + "\n".join("    " + l for l in code.split("\n"))
            ns = {"__name__": "__kojy__"}
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


def run_all(fn, repeat, slow):
    """Calls fn `repeat` times; async results are awaited in one event loop in debug mode."""
    first = fn()
    if not inspect.isawaitable(first):
        for _ in range(repeat - 1):
            fn()
        return

    async def go():
        loop = asyncio.get_running_loop()
        loop.slow_callback_duration = 0.05
        await first
        for _ in range(repeat - 1):
            await fn()

    logging.getLogger("asyncio").addHandler(slow)
    asyncio.run(go(), debug=True)


def where(file, line, name):
    if file == "~":
        return name
    return f"{os.path.relpath(file, ROOT) if is_bot_file(file) else os.path.basename(file)}:{line} {name}"


def bot_callers(stats, key, depth=0, seen=None):
    """The bot functions a slow call was reached from (walking up the callers)."""
    seen = seen or set()
    out = []
    for caller in stats.stats.get(key, (0, 0, 0, 0, {}))[4]:
        if caller in seen:
            continue
        seen.add(caller)
        if is_bot_file(caller[0]):
            out.append(caller)
        elif depth < 6:
            out.extend(bot_callers(stats, caller, depth + 1, seen))
    return out


def profile(spec):
    fn, label = target_of(spec)
    repeat = max(1, min(int(spec.get("repeat") or 1), 10_000))
    slow = SlowCallbacks()
    prof = cProfile.Profile()
    out = io.StringIO()
    tracemalloc.start()
    started = time.perf_counter()
    error = None
    with contextlib.redirect_stdout(out), LineSampler() as sampler:
        prof.enable()
        try:
            run_all(fn, repeat, slow)
        except BaseException as e:  # still show where the time went
            error = f"{type(e).__name__}: {e}"
        finally:
            prof.disable()
    took = time.perf_counter() - started
    _, peak = tracemalloc.get_traced_memory()
    snapshot = tracemalloc.take_snapshot()
    tracemalloc.stop()
    per = f" ({fmt_time(took / repeat)} per call, {repeat} calls)" if repeat > 1 else ""
    print(f"Profiled {label}: {fmt_time(took)} in total{per}, peak memory {fmt_bytes(peak)}")
    if error:
        print(f"It raised {error}")
    stats = pstats.Stats(prof)
    rows = []
    for key, (cc, nc, tt, ct, _) in stats.stats.items():
        file, line, name = key
        if file == SELF or "cProfile" in file or name in ("<built-in method builtins.exec>", "disable") or file.startswith("<frozen"):
            continue
        # Python's own machinery (asyncio's loop, importlib…) only hides what matters; built-ins like time.sleep stay.
        if file.startswith(STDLIB) and "site-packages" not in file:
            continue
        rows.append((ct, tt, nc, key, is_bot_file(file)))
    rows.sort(key=lambda r: -r[0])
    # Shown: the bot's code, and other calls that take a real share (asyncio's wrapper and
    # debug-mode bookkeeping — reading source files for tracebacks — only hide what matters).
    shown = [r for r in rows if r[4] or (r[0] >= took * 0.02 and "_contextvars" not in r[3][2])]
    print("\nSlowest by total time (incl. what they call) — * = the bot's own code:")
    print("   total     own     calls  function")
    for ct, tt, nc, key, mine in shown[:12]:
        print(f"{fmt_time(ct):>9} {fmt_time(tt):>8} {nc:>8}  {'*' if mine else ' '} {where(*key)[:110]}")

    if sampler.hits:
        bot = sum(sampler.hits.values())
        print(f"\nHottest lines of the bot's own code (CPU samples; {bot} of {sampler.total} were in its code):")
        for (file, line, name), n in sampler.hits.most_common(8):
            src = ""
            try:
                with open(file, encoding="utf-8", errors="replace") as fh:
                    src = fh.read().split("\n")[line - 1].strip()[:90]
            except (OSError, IndexError):
                pass
            print(f"  {100 * n / max(sampler.total, 1):5.1f}%  {os.path.relpath(file, ROOT)}:{line} in {name}: {src}")

    # Library or built-in calls with a lot of their own time, and where in the bot they were made.
    heavy = [r for r in rows if not r[4] and r[1] >= max(0.02, took * 0.1)]
    if heavy:
        print("\nSlow calls into libraries / Python, and the bot code that made them:")
        for ct, tt, nc, key, _ in heavy[:5]:
            callers = bot_callers(stats, key)
            made = ", ".join(where(*c) for c in callers[:3]) or "(not from the bot's code)"
            print(f"  {where(*key)[:70]}: {fmt_time(tt)} in {nc} call{'s' if nc != 1 else ''} — from {made}")

    mem = [s for s in snapshot.statistics("lineno") if is_bot_file(s.traceback[0].filename)][:5]
    if mem:
        print("\nMemory still held at the end, by line of the bot's code:")
        for s in mem:
            f = s.traceback[0]
            print(f"  {fmt_bytes(s.size):>9}: {os.path.relpath(f.filename, ROOT)}:{f.lineno}")
    if slow.seen:
        print(f"\nBLOCKED THE EVENT LOOP {len(slow.seen)} time(s) (over 50 ms each; the bot can't answer anyone meanwhile):")
        for m in slow.seen[:5]:
            took_s = m.rsplit(" took ", 1)[-1]
            print(f"  a step of the async code took {took_s}")
        culprits = [r for r in heavy if r[3][2].startswith("<built-in method time.sleep") or "sleep" in r[3][2] or "requests" in r[3][0] or "socket" in r[3][2] or "urlopen" in r[3][2]]
        for ct, tt, nc, key, _ in culprits[:3]:
            made = ", ".join(where(*c) for c in bot_callers(stats, key)[:3])
            print(f"  likely cause: {where(*key)[:60]} ({fmt_time(tt)}){f', from {made}' if made else ''}")
        print("Use await asyncio.sleep instead of time.sleep, an async library (aiohttp) instead of requests, or asyncio.to_thread for heavy work.")
    printed = out.getvalue()
    if printed:
        print("\nIt printed (last part):\n" + printed[-1200:])


# ── benchmark ───────────────────────────────────────────────────────────────


class Variant:
    """One version of the code, ready to run many times in its own namespace."""

    def __init__(self, label, code, setup, extra=None):
        self.label = label
        self.ns = {"__name__": "__kojy__", **(extra or {})}
        exec(compile(setup or "pass", "<setup>", "exec"), self.ns)
        self.is_async = "await " in code
        if self.is_async:
            src = "async def __kojy_run__():\n" + "\n".join("    " + l for l in code.split("\n"))
            exec(compile(src, f"<{label}>", "exec"), self.ns)
            self.loop = asyncio.new_event_loop()
            self.once = lambda: self.loop.run_until_complete(self.ns["__kojy_run__"]())
        else:
            compiled = compile(code, f"<{label}>", "exec")
            self.once = lambda: exec(compiled, self.ns)
        self.number = 1
        self.samples = []

    def calibrate(self, target):
        self.once()  # warm up (imports, caches)
        while True:
            t = time.perf_counter()
            for _ in range(self.number):
                self.once()
            if time.perf_counter() - t >= target or self.number >= 1_000_000:
                return
            self.number *= 2

    def sample(self):
        t = time.perf_counter()
        for _ in range(self.number):
            self.once()
        self.samples.append((time.perf_counter() - t) / self.number)

    def peak_memory(self):
        tracemalloc.start()
        try:
            self.once()
            return tracemalloc.get_traced_memory()[1]
        finally:
            tracemalloc.stop()

    def close(self):
        if self.is_async:
            self.loop.close()

    @property
    def median(self):
        return statistics.median(self.samples)

    @property
    def noise(self):
        """Spread of the samples (interquartile range / median)."""
        if len(self.samples) < 4:
            return 0.0
        q = statistics.quantiles(self.samples, n=4)
        return (q[2] - q[0]) / self.median if self.median else 0.0


def measure(variants, budget):
    """Samples the variants in turns until the time budget is used (at least 7 each)."""
    for v in variants:
        v.calibrate(budget / 30)
    start = time.perf_counter()
    while True:
        for v in variants:
            v.sample()
        n = len(variants[0].samples)
        elapsed = time.perf_counter() - start
        # 7 rounds when they're quick; 3 when one round already takes a big part of the budget (slow code).
        need = 7 if (elapsed / n) * 7 <= budget * len(variants) * 2 else 3
        if (n >= need and elapsed >= budget * len(variants)) or n >= 40 or (n >= 3 and elapsed > budget * len(variants) * 3):
            return


def same(a, b):
    try:
        if iter(a) is a and iter(b) is b:  # iterators: compare what they give
            a, b = list(a), list(b)
    except TypeError:
        pass
    try:
        r = a == b
        if isinstance(r, bool):
            return r
        return bool(getattr(r, "all", lambda: r)())  # numpy arrays and the like
    except Exception:
        return repr(a) == repr(b)


def growth(points):
    """The exponent k in time ≈ c·n^k (least squares on log-log), and what it means."""
    xs = [math.log(n) for n, t in points if t > 0]
    ys = [math.log(t) for n, t in points if t > 0]
    if len(xs) < 2:
        return 0.0, "unknown"
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    k = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sum((x - mx) ** 2 for x in xs) or 1)
    label = ("constant: size doesn't matter" if k < 0.3 else "about linear, O(n)" if k < 1.3
             else "between linear and quadratic, e.g. O(n log n) with a big constant or partly quadratic" if k < 1.7
             else "quadratic, O(n²): twice the data takes 4× as long" if k < 2.5 else "cubic or worse")
    return k, label


def quartiles(v):
    """Lower quartile, median, upper quartile of a variant's samples (min/median/max when there are few)."""
    if len(v.samples) >= 4:
        q = statistics.quantiles(v.samples, n=4)
        return q[0], v.median, q[2]
    return min(v.samples), v.median, max(v.samples)


def verdict(old, new):
    """Faster (or slower) only when it's at least 5% and the middle halves of the two sets of timings don't overlap."""
    ratio = old.median / new.median if new.median else float("inf")
    (o1, _, o3), (n1, _, n3) = quartiles(old), quartiles(new)
    spread = max(old.noise, new.noise) * 50
    if ratio >= 1.05 and o1 > n3:
        return ratio, f"the new version is {ratio:.2f}× faster" if ratio < 2 else f"the new version is {ratio:.1f}× faster"
    if ratio <= 1 / 1.05 and n1 > o3:
        return ratio, f"the new version is {1 / ratio:.2f}× SLOWER" if ratio > 0.5 else f"the new version is {1 / ratio:.1f}× SLOWER"
    return ratio, f"no real difference (the timings overlap; runs vary ±{spread:.0f}%)"


def benchmark(spec):
    budget = min(max(float(spec.get("seconds") or 2), 0.5), 8)
    sizes = [int(n) for n in (spec.get("sizes") or []) if 0 < int(n) <= 10_000_000][:6]
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        if sizes:
            report = scaling(spec, sizes, budget)
        else:
            report = compare(spec, budget)
    print(report)


def compare(spec, budget):
    new = Variant("new", spec["code"], spec.get("setup"))
    old = Variant("baseline", spec["baseline"], spec.get("setup")) if spec.get("baseline") else None
    variants = [old, new] if old else [new]
    measure(variants, budget)
    lines = []
    for v in variants:
        label = f"{v.label + ':':<10}" if old else ""
        lines.append(f"{label}{fmt_time(v.median)} per run (best {fmt_time(min(v.samples))}, ±{v.noise * 50:.0f}%, {v.number * len(v.samples)} runs), peak memory {fmt_bytes(v.peak_memory())}")
    if old:
        _, text = verdict(old, new)
        lines.append(f"RESULT: {text}")
        mo, mn = old.peak_memory(), new.peak_memory()
        if mo and mn and (mo / mn > 1.5 or mn / mo > 1.5):
            lines.append(f"Memory: the new version uses {mo / mn:.1f}× less" if mo > mn else f"Memory: the new version uses {mn / mo:.1f}× MORE")
        if "result" in old.ns and "result" in new.ns:
            ok = same(old.ns["result"], new.ns["result"])
            lines.append("Same `result` from both: yes" if ok else f"Same `result` from both: NO — baseline {repr(old.ns['result'])[:200]}, new {repr(new.ns['result'])[:200]}")
        elif "result" in old.ns or "result" in new.ns:
            lines.append("Only one version sets `result`, so they can't be compared: set it in both.")
    for v in variants:
        v.close()
    return "\n".join(lines)


def scaling(spec, sizes, budget):
    sizes = sorted(set(sizes))
    each = max(0.2, budget / len(sizes))
    pairs = [("new", spec["code"])] + ([("baseline", spec["baseline"])] if spec.get("baseline") else [])
    lines = [f"How the time grows with n (setup sees n = {', '.join(map(str, sizes))}):"]
    curves = {}
    for label, code in pairs:
        points = []
        for n in sizes:
            v = Variant(label, code, spec.get("setup"), {"n": n})
            measure([v], each / 2)
            points.append((n, v.median))
            v.close()
            if v.median * v.number > 5:  # one more size would take too long
                break
        k, text = growth(points)
        curves[label] = points
        lines.append(f"{label}: " + ", ".join(f"n={n}: {fmt_time(t)}" for n, t in points))
        lines.append(f"  → grows like n^{k:.2f}: {text}")
    if len(curves) == 2:
        n, tn = curves["new"][-1]
        tb = dict(curves["baseline"]).get(n)
        if tb:
            lines.append(f"RESULT: at n={n} the new version is {tb / tn:.1f}× {'faster' if tb >= tn else 'SLOWER'}")
    return "\n".join(lines)


def main():
    mode, spec = sys.argv[1], json.loads(sys.argv[2])
    try:
        (profile if mode == "profile" else benchmark)(spec)
    except BaseException as e:
        print(f"FAILED: {type(e).__name__}: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
