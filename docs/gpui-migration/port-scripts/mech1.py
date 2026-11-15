"""Mechanical source changes of the port from GPUI 0.2.2 to gpui-next.

Run from the client crate (src/ui/gpui): python -I mech1.py <crate dir>
Each rule prints how many places it changed. Files keep LF endings.
"""
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1]) / "src"

RULES = [
    # Styled::flex_shrink takes the factor now; the bare call was shrink 1.
    ("flex_shrink() -> flex_shrink_1()", re.compile(r"\.flex_shrink\(\)"), ".flex_shrink_1()"),
    # ScrollHandle::max_offset is a Point now (was a Size).
    ("max_offset().height -> .y", re.compile(r"(max_offset(?:_for_scrollbar)?)\(\)\.height"), r"\1().y"),
    ("max_offset().width -> .x", re.compile(r"(max_offset(?:_for_scrollbar)?)\(\)\.width"), r"\1().x"),
    # track_scroll borrows the handle now.
    ("track_scroll(x.clone()) -> track_scroll(&x)",
     re.compile(r"\.track_scroll\(([A-Za-z_][\w\.]*)\.clone\(\)\)"), r".track_scroll(&\1)"),
]


def add_inset(text):
    """BoxShadow gained `inset: bool`: every initializer gets `inset: false`."""
    out, count, pos = [], 0, 0
    pattern = re.compile(r"BoxShadow \{\n")
    while True:
        m = pattern.search(text, pos)
        if not m:
            out.append(text[pos:])
            break
        start = m.end()
        depth, i = 1, start
        while depth:
            c = text[i]
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
            i += 1
        body = text[start:i - 1]
        if "inset" in body:
            out.append(text[pos:i])
            pos = i
            continue
        first = body.split("\n", 1)[0]
        indent = first[: len(first) - len(first.lstrip())]
        close_line_start = text.rfind("\n", 0, i - 1) + 1
        out.append(text[pos:close_line_start])
        out.append(f"{indent}inset: false,\n")
        pos = close_line_start
        count += 1
    return "".join(out), count


totals = {name: 0 for name, _, _ in RULES}
totals["BoxShadow inset: false"] = 0
for path in sorted(root.rglob("*.rs")):
    text = path.read_text(encoding="utf-8")
    new = text
    for name, pattern, repl in RULES:
        new, n = pattern.subn(repl, new)
        totals[name] += n
    new, n = add_inset(new)
    totals["BoxShadow inset: false"] += n
    if new != text:
        path.write_bytes(new.encode("utf-8"))
for name, n in totals.items():
    print(f"{n:4}  {name}")
