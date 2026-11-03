/** Memoizing a pending computation: shared while it runs, forgotten if it fails. */

/** What {@link memoized} needs of its store; `Map` and `LruCache` both qualify. */
export interface PromiseStore<K, V> {
  get(key: K): Promise<V> | undefined
  set(key: K, value: Promise<V>, weight?: number): unknown
  delete(key: K): unknown
}

/**
 * The value stored under `key`, computed and stored when absent. The pending
 * promise is shared with concurrent callers; a failed one is removed, so the
 * next caller tries again.
 *
 * @param weight - what the entry counts for in a weighted store
 */
export function memoized<K, V>(
  store: PromiseStore<K, V>,
  key: K,
  compute: () => Promise<V>,
  weight?: number,
): Promise<V> {
  let pending = store.get(key)
  if (pending === undefined) {
    pending = compute().catch((error: unknown) => {
      store.delete(key)
      throw error
    })
    store.set(key, pending, weight)
  }
  return pending
}
