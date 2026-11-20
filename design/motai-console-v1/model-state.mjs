export const parseModels = (value) => [...new Set(String(value).split(/[\n,]+/).map((x) => x.trim()).filter(Boolean))];

export function matchingModels(catalog, selected, search = '', onlySelected = false) {
  const query = search.trim().toLowerCase();
  return [...new Set([...catalog, ...selected])].filter((id) => id.toLowerCase().includes(query) && (!onlySelected || selected.has(id)));
}

export function modelPage(catalog, selected, search = '', onlySelected = false, page = 0) {
  const matches = matchingModels(catalog, selected, search, onlySelected);
  const lastPage = Math.max(0, Math.ceil(matches.length / 50) - 1);
  const current = Math.min(page, lastPage);
  const upstream = new Set(catalog);
  return { total: matches.length, page: current, lastPage, items: matches.slice(current * 50, current * 50 + 50).map((id) => ({ id, selected: selected.has(id), missing: !upstream.has(id) })) };
}
