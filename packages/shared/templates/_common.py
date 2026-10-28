# ── shared helpers (copied into every template's bot.py by gen-templates) ──
import json
from pathlib import Path

DATA = Path("data")


def load(name, default):
    """Read data/<name> (JSON), or the default if it doesn't exist yet."""
    try:
        return json.loads((DATA / name).read_text())
    except Exception:
        return default


def save(name, value):
    """Write data/<name> safely (a crash mid-write never leaves half a file)."""
    DATA.mkdir(exist_ok=True)
    tmp = DATA / (name + ".tmp")
    tmp.write_text(json.dumps(value, indent=1))
    tmp.replace(DATA / name)


def chunks(text, size=240):
    """Highrise chat messages are short; split long text into pieces."""
    out, line = [], ""
    for part in text.split("\n"):
        if len(line) + len(part) + 1 > size and line:
            out.append(line)
            line = part
        else:
            line = f"{line}\n{part}" if line else part
    if line:
        out.append(line)
    return out
