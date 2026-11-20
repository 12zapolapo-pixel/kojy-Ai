"""Starts a KojyAI bot on a bot host (a Pterodactyl-style server).

KojyAI uploads this file as kojy_start.py, the file the host runs, with:
    kojy_launcher.py          KojyAI's launcher (freeze watchdog, room checks)
    .kojy/env.json            the bot's settings and secrets
    .kojy/requirements.txt    the packages it needs
and the bot's own code next to them. Packages are installed into
.kojy/packages again only when the requirements (or Python) change.
"""

from __future__ import annotations

import hashlib
import shutil
import json
import os
import runpy
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
KOJY = os.path.join(HERE, ".kojy")
PACKAGES = os.path.join(KOJY, "packages")
INSTALL_TIMEOUT_S = int(os.environ.get("KOJY_INSTALL_TIMEOUT_S", "1200"))


def say(message: str) -> None:
    print(f"[kojy] {message}", flush=True)


def load_settings() -> None:
    try:
        with open(os.path.join(KOJY, "env.json"), encoding="utf-8") as f:
            values = json.load(f)
    except FileNotFoundError:
        say("The bot's settings are missing here. Start the bot from KojyAI so it uploads them.")
        raise SystemExit(2)
    for key, value in values.items():
        if isinstance(key, str) and isinstance(value, str):
            os.environ[key] = value


def install_packages() -> None:
    requirements = os.path.join(KOJY, "requirements.txt")
    if not os.path.exists(requirements):
        return
    with open(requirements, "rb") as f:
        wanted = hashlib.sha256(f.read() + sys.version.encode()).hexdigest()
    marker = os.path.join(KOJY, "installed")
    # KojyAI asked for a fresh start (the bot kept going quiet or couldn't connect): install everything
    # again — once per request (env.json stays there if the host restarts the server by itself).
    fresh_id = os.environ.get("KOJY_FRESH_INSTALL", "")
    fresh_done = os.path.join(KOJY, "fresh")
    try:
        with open(fresh_done, encoding="utf-8") as f:
            fresh = bool(fresh_id) and f.read().strip() != fresh_id
    except FileNotFoundError:
        fresh = bool(fresh_id)
    try:
        with open(marker, encoding="utf-8") as f:
            if f.read().strip() == wanted and os.path.isdir(PACKAGES) and not fresh:
                return
    except FileNotFoundError:
        pass
    if fresh:
        shutil.rmtree(PACKAGES, ignore_errors=True)
    say("Installing packages (first run or requirements.txt changed)…")
    try:
        # A stuck install (the host's network) would leave the server "running"
        # with no bot in it and nothing checking: give up after a while instead.
        done = subprocess.run(
            [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-input",
             "--no-cache-dir", "--upgrade", "--target", PACKAGES, "-r", requirements],
            cwd=HERE, timeout=INSTALL_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        limit = f"{INSTALL_TIMEOUT_S // 60} minutes" if INSTALL_TIMEOUT_S >= 120 else f"{INSTALL_TIMEOUT_S} seconds"
        say(f"Installing packages took more than {limit} — stopped.")
        raise SystemExit(2)
    if done.returncode != 0:
        say(f"Installing packages failed (pip exit {done.returncode}).")
        raise SystemExit(2)
    with open(marker, "w", encoding="utf-8") as f:
        f.write(wanted)
    if fresh:
        with open(fresh_done, "w", encoding="utf-8") as f:
            f.write(fresh_id)


def main() -> None:
    load_settings()
    install_packages()
    os.chdir(HERE)
    sys.path.insert(0, PACKAGES)
    os.environ["PYTHONPATH"] = PACKAGES + (os.pathsep + os.environ["PYTHONPATH"] if os.environ.get("PYTHONPATH") else "")
    launcher = os.path.join(HERE, "kojy_launcher.py")
    sys.argv = [launcher]
    runpy.run_path(launcher, run_name="__main__")


if __name__ == "__main__":
    main()
