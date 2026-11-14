// GitHub-style pagination: `per_page`/`page` query params and the `Link`
// header with absolute URLs (the suite follows rel="next" only same-origin).

export interface PageParams {
  readonly perPage: number;
  readonly page: number;
}

/** Parse per_page (default 30, clamped 1..100) and page (default 1, min 1). */
export function parsePageParams(query: URLSearchParams): PageParams {
  const perPageRaw = Number(query.get('per_page'));
  const pageRaw = Number(query.get('page'));
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.trunc(perPageRaw))) : 30;
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
  return { perPage, page };
}

export interface Page<T> {
  readonly items: T[];
  readonly total: number;
  readonly hasNext: boolean;
  readonly hasPrev: boolean;
}

/** Slice `items` (already in stable order) to one page. */
export function paginate<T>(items: readonly T[], params: PageParams): Page<T> {
  const start = (params.page - 1) * params.perPage;
  const pageItems = items.slice(start, start + params.perPage);
  return {
    items: pageItems,
    total: items.length,
    hasNext: start + params.perPage < items.length,
    hasPrev: params.page > 1,
  };
}

/**
 * Build the Link header for a page. `base` is the absolute URL without query
 * params; `extra` carries any non-pagination query params to preserve.
 * Emits first/last always, prev when page > 1, next when there is one.
 */
export function buildLinkHeader(
  base: string,
  params: PageParams,
  total: number,
  extra: Readonly<Record<string, string>> = {},
): string | undefined {
  const lastPage = Math.max(1, Math.ceil(total / params.perPage));
  const urlFor = (page: number): string => {
    const query = new URLSearchParams({ ...extra, per_page: String(params.perPage), page: String(page) });
    return `${base}?${query.toString()}`;
  };
  const parts: string[] = [`<${urlFor(1)}>; rel="first"`, `<${urlFor(lastPage)}>; rel="last"`];
  if (params.page > 1) parts.push(`<${urlFor(params.page - 1)}>; rel="prev"`);
  if (params.page < lastPage) parts.push(`<${urlFor(params.page + 1)}>; rel="next"`);
  return parts.join(', ');
}
