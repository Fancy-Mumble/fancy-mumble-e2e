"""Focus calls take the App now (gpui-next: Window::focus(&handle, cx),
FocusHandle::focus(window, cx), Window::blur(cx), focus_next(cx), ...).

- `X.read(cx).focus(window)` (a TextInput entity) becomes
  `window.focus(&X.focus_handle(cx), cx)`: the entity is Focusable.
- `composer.focus(window)` inside an update of the field becomes
  `composer.focus(window, cx)`; TextInput::focus takes `cx: &mut App`.
- `.focus(window)` on a FocusHandle becomes `.focus(window, cx)`.

Run from the client crate: python -I mech2.py <crate dir>
"""
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1]) / "src"
read_focus = re.compile(r"([A-Za-z_][\w\.\[\]]*)\.read\(cx\)\.focus\(window\)")
plain_focus = re.compile(r"\b(composer|self\.end\(way\)|self\.head)\.focus\(window\)")
counts = {"read(cx).focus(window)": 0, "x.focus(window)": 0}
for path in sorted(root.rglob("*.rs")):
    text = path.read_text(encoding="utf-8")
    new, n = read_focus.subn(r"window.focus(&\1.focus_handle(cx), cx)", text)
    counts["read(cx).focus(window)"] += n
    new, n = plain_focus.subn(r"\1.focus(window, cx)", new)
    counts["x.focus(window)"] += n
    if new != text:
        path.write_bytes(new.encode("utf-8"))
for name, n in counts.items():
    print(f"{n:4}  {name}")
