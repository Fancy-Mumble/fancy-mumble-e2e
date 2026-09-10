/**
 * Escape a value for use inside a CSS attribute selector's double-quoted
 * string, e.g. `[data-user-name="<here>"]`.
 *
 * Display names reach the selectors as they were typed, and one carrying a
 * quote or a backslash would otherwise close the string early - surfacing as
 * an InvalidSelectorError that reads like a missing element.
 *
 * The XPath counterpart is {@link import("./xpath").xpathLiteral}.
 */
export function cssAttrEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
