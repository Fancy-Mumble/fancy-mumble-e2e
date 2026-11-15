"""Deprecated names in gpui-next: `ScrollWheelEvent` is `ScrollEvent`, and
`on_scroll_wheel` is `on_scroll`.

Run: python -I mech4.py <crate dir>
"""
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1]) / "src"
rules = [
    ("ScrollWheelEvent -> ScrollEvent", re.compile(r"\bScrollWheelEvent\b"), "ScrollEvent"),
    ("on_scroll_wheel -> on_scroll", re.compile(r"\.on_scroll_wheel\("), ".on_scroll("),
]
totals = {name: 0 for name, _, _ in rules}
for path in sorted(root.rglob("*.rs")):
    text = path.read_text(encoding="utf-8")
    new = text
    for name, pattern, repl in rules:
        new, n = pattern.subn(repl, new)
        totals[name] += n
    if new != text:
        path.write_bytes(new.encode("utf-8"))
for name, n in totals.items():
    print(f"{n:4}  {name}")
