/**
 * Vendor-neutral pagination types.
 *
 * @module
 */

/**
 * A single page of results returned by a `list` operation.
 *
 * {@link Page.hasMore} says whether another page is available beyond the
 * returned {@link Page.data}; when it is, {@link Page.nextCursor} requests it,
 * passed as the list params' `startingAfter`.
 */
export interface Page<A> {
  readonly data: ReadonlyArray<A>;
  readonly hasMore: boolean;
  /**
   * The cursor of the next page, present when {@link Page.hasMore} is: pass it
   * as `startingAfter`, with the same `limit` and filters, to list that page.
   * It is opaque, and only the provider that returned it reads it (the last
   * item's id, say, or an encoded page number).
   */
  readonly nextCursor?: string | undefined;
}

/**
 * The result of deleting a resource: the id of the deleted entity.
 */
export interface Deleted {
  readonly id: string;
  readonly deleted: true;
}
