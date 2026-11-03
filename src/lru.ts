/**
 * A least-recently-used map with a capacity in weight units: entries, by
 * default, or whatever weight each `set` gives (bytes, say). The newest entry
 * is kept even when it alone exceeds the capacity.
 */
export class LruCache<K, V> {
  readonly #entries = new Map<K, { value: V; weight: number }>()
  readonly #capacity: number
  #total = 0

  constructor(capacity: number) {
    this.#capacity = capacity
  }

  get(key: K): V | undefined {
    const entry = this.#entries.get(key)
    if (entry === undefined) return undefined
    // Map keeps insertion order: re-inserting marks the entry most recent.
    this.#entries.delete(key)
    this.#entries.set(key, entry)
    return entry.value
  }

  set(key: K, value: V, weight = 1): void {
    this.delete(key)
    this.#entries.set(key, { value, weight })
    this.#total += weight
    while (this.#total > this.#capacity && this.#entries.size > 1) {
      this.delete(this.#entries.keys().next().value as K)
    }
  }

  delete(key: K): void {
    const entry = this.#entries.get(key)
    if (entry === undefined) return
    this.#total -= entry.weight
    this.#entries.delete(key)
  }
}
