// Places API (New) text search, bearer-token only.
//
// There is no API key anywhere in this pipeline: the workflow mints a short
// lived Workload Identity token, so there is nothing long-lived to leak or
// restrict. No token, no client — jobs/run.mjs simply leaves `places` off deps.
//
// One call returns up to 20 places and that is exactly what one sourcing run
// wants, so there is no paging here. Add `nextPageToken` handling the day a
// grid cell needs more than a page per week.

// Only the fields the businesses table stores. A '*' mask silently upgrades
// every call to the priciest SKU.
export const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.nationalPhoneNumber',
  'places.websiteUri',
  'places.rating',
  'places.userRatingCount',
].join(',')

export const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText'

export function createPlaces({ token, project, fetch = globalThis.fetch, maxResults = 20 } = {}) {
  if (!token) throw new Error('createPlaces needs an access token')

  return {
    async search(query) {
      const res = await fetch(SEARCH_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'X-Goog-FieldMask': FIELD_MASK,
          'x-goog-user-project': project ?? '',
        },
        body: JSON.stringify({ textQuery: query, maxResultCount: maxResults }),
      })
      if (!res.ok) {
        throw new Error(`places search failed (${res.status}): ${String(await res.text()).slice(0, 300)}`)
      }
      const body = await res.json()
      return (body?.places ?? []).map((p) => ({
        place_id: p.id ?? null,
        name: p.displayName?.text ?? null,
        phone: p.nationalPhoneNumber ?? null,
        website: p.websiteUri ?? null,
        address: p.formattedAddress ?? null,
        rating: p.rating ?? null,
        review_count: p.userRatingCount ?? null,
      }))
    },
  }
}
