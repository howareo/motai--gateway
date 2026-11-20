// Model IDs are opaque and case-sensitive; only surrounding whitespace is removed.
export function parseModelList(value) {
  if (value === null || value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.some((item) => typeof item !== 'string')) throw new TypeError('模型列表必须是字符串');
  return [...new Set(values.flatMap((item) => item.split(/[\n,]+/)).map((item) => item.trim()).filter(Boolean))];
}
