"""After mech2.py: `Entity::focus_handle` is the `Focusable` trait's, which
must be in scope. Adds `use gpui::Focusable as _;` before the first
`use gpui` line of every file that calls `.focus_handle(cx), cx)` and does
not name `Focusable` yet.

Run: python -I mech3.py <crate dir>
"""
import pathlib
import sys

root = pathlib.Path(sys.argv[1]) / "src"
count = 0
for path in sorted(root.rglob("*.rs")):
    text = path.read_text(encoding="utf-8")
    if ".focus_handle(cx), cx)" not in text or "Focusable" in text:
        continue
    lines = text.split("\n")
    at = next((i for i, line in enumerate(lines) if line.startswith("use gpui")), None)
    if at is None:
        # Inside a module (tests): before its first `use`.
        at = next(i for i, line in enumerate(lines) if line.lstrip().startswith("use "))
        indent = lines[at][: len(lines[at]) - len(lines[at].lstrip())]
        lines.insert(at, f"{indent}use gpui::Focusable as _;")
    else:
        lines.insert(at, "use gpui::Focusable as _;")
    path.write_bytes("\n".join(lines).encode("utf-8"))
    count += 1
    print(path.relative_to(root))
print(f"{count:4}  files given `use gpui::Focusable as _;`")
