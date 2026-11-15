"""Adds `<field>: <value>,` to every multi-line `<Struct> {` initializer that
lacks it and does not end in `..base`.

Run: python -I add_field.py <dir> <Struct> <field> <value>
"""
import pathlib
import re
import sys

root, struct, field, value = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
pattern = re.compile(r"\b" + re.escape(struct) + r" \{\n")
total = 0
for path in sorted(root.rglob("*.rs")):
    text = path.read_text(encoding="utf-8")
    out, pos, count = [], 0, 0
    while True:
        m = pattern.search(text, pos)
        if not m:
            out.append(text[pos:])
            break
        # Not a definition (`struct X {`) or an impl block.
        line_start = text.rfind("\n", 0, m.start()) + 1
        head = text[line_start:m.start()]
        if re.search(r"\b(struct|impl|enum|for)\b", head):
            out.append(text[pos:m.end()])
            pos = m.end()
            continue
        start = m.end()
        depth, i = 1, start
        while depth:
            c = text[i]
            if c in "{([":
                depth += 1
            elif c in "})]":
                depth -= 1
            i += 1
        body = text[start:i - 1]
        if re.search(r"\b" + re.escape(field) + r"\b", body) or body.strip().splitlines()[-1].strip().startswith(".."):
            out.append(text[pos:i])
            pos = i
            continue
        first = body.split("\n", 1)[0]
        indent = first[: len(first) - len(first.lstrip())]
        close_line_start = text.rfind("\n", 0, i - 1) + 1
        out.append(text[pos:close_line_start])
        out.append(f"{indent}{field}: {value},\n")
        pos = close_line_start
        count += 1
    if count:
        path.write_bytes("".join(out).encode("utf-8"))
        print(f"{count:3} {path}")
        total += count
print(f"{total} initializers of {struct} given {field}")
