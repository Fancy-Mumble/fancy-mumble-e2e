/**
 * Quote an arbitrary string for safe use as an XPath string literal.
 * Handles values containing single and/or double quotes by falling back
 * to `concat(...)`.
 */
export function xpathLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  const parts = value.split("'").map((p) => `'${p}'`);
  return `concat(${parts.join(`, "'", `)})`;
}
