/**
 * Background preloader for full-recording streaming (website#254). Pure logic
 * only -- no zarr / DOM / localStorage dependency, so it is unit-tested
 * directly with a fake transport (a stand-in for the network boundary, not a
 * mock of business logic: it returns real-shape byte-accounted payloads and
 * the tests assert on the controller's own scheduling/cache decisions).
 *
 * Two pieces:
 *
 * - `ByteCappedLRUCache<T>` -- a byte-accounted LRU cache with two insert
 *   modes. `put` (the interactive path) evicts least-recently-used entries as
 *   needed to fit, same as any bounded cache. `putIfRoom` (the background
 *   scheduler) never evicts: it fails once the cache is full rather than
 *   displacing whatever the user is currently looking at, per website#254's
 *   "stop rather than evict" requirement.
 * - `PrefetchController<T>` -- walks a recording's segment grid outward from
 *   the current playhead, filling the cache one segment at a time, pausing
 *   for interactive reads and `document.hidden`, and stopping cleanly on
 *   abort or on a full cache.
 *
 * `viewer.ts` supplies the transport (an explicit-level read against
 * store.ts), the localStorage-backed settings, and the DOM wiring
 * (visibilitychange, destroy). Nothing here touches any of that.
 */

export interface CacheEntry<T> {
  value: T;
  bytes: number;
}

/**
 * A `Map`'s iteration order is insertion order, and re-inserting a key (via
 * delete+set) moves it to the end -- so the map doubles as the LRU list with
 * the least-recently-used entry always first. No separate linked list needed.
 */
export class ByteCappedLRUCache<T> {
  private capBytes: number;
  private map = new Map<string, CacheEntry<T>>();
  private used = 0;

  constructor(capBytes: number) {
    this.capBytes = Math.max(0, capBytes);
  }

  get capacityBytes(): number {
    return this.capBytes;
  }

  get usedBytes(): number {
    return this.used;
  }

  get remainingBytes(): number {
    return Math.max(0, this.capBytes - this.used);
  }

  get count(): number {
    return this.map.size;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Look up without disturbing recency (does not count as a "use"). */
  peek(key: string): T | undefined {
    return this.map.get(key)?.value;
  }

  /** Look up and mark most-recently-used. */
  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  delete(key: string): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    this.map.delete(key);
    this.used -= entry.bytes;
    return true;
  }

  clear(): void {
    this.map.clear();
    this.used = 0;
  }

  /**
   * Interactive insert: evicts the least-recently-used entries to make room
   * when necessary. Returns false only when the entry itself is larger than
   * the whole cap (nothing to evict would make it fit), in which case nothing
   * is stored.
   */
  put(key: string, value: T, bytes: number): boolean {
    this.delete(key);
    if (bytes > this.capBytes) return false;
    while (this.used + bytes > this.capBytes) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      this.delete(oldestKey);
    }
    this.map.set(key, { value, bytes });
    this.used += bytes;
    return true;
  }

  /**
   * Background insert: never evicts. Fails (returns false) once the entry
   * would not fit in the remaining headroom, leaving every existing entry
   * untouched -- this is the "stop rather than evict" half of website#254.
   * A key already present counts as success without bumping recency (a
   * background re-visit of an already-cached segment is not a "use").
   */
  putIfRoom(key: string, value: T, bytes: number): boolean {
    if (this.map.has(key)) return true;
    if (bytes > this.remainingBytes) return false;
    this.map.set(key, { value, bytes });
    this.used += bytes;
    return true;
  }

  /** Shrinks by evicting LRU entries when the new cap is smaller than what is
   *  resident; a larger cap just raises the ceiling for future inserts. */
  setCapacity(capBytes: number): void {
    this.capBytes = Math.max(0, capBytes);
    while (this.used > this.capBytes) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      this.delete(oldestKey);
    }
  }
}

/**
 * Segment visit order for the background walk: the segment containing the
 * playhead first, then alternating outward (+1, -1, +2, -2, ...), clamped to
 * the recording's bounds with no wraparound. Ties break toward the forward
 * (later-in-time) direction first, matching the more common "keep reading
 * forward" scrub pattern. Pure and exported for direct testing.
 */
export function outwardOrder(totalSegments: number, center: number): number[] {
  if (totalSegments <= 0) return [];
  const c = Math.max(0, Math.min(totalSegments - 1, Math.floor(center)));
  const order = [c];
  for (let d = 1; d < totalSegments; d++) {
    const fwd = c + d;
    const back = c - d;
    if (fwd <= totalSegments - 1) order.push(fwd);
    if (back >= 0) order.push(back);
  }
  return order;
}

/**
 * Maps a wall-clock time to a segment index on a fixed-width grid, or null
 * when `startS` does not land on a grid line within `epsilonS` -- used by the
 * interactive read path to decide whether the window it wants is an exact
 * cache hit (page navigation moves in whole segment widths) versus an
 * arbitrary scrub position (falls through to a normal network read).
 */
export function segmentIndexForTime(
  startS: number,
  segmentSeconds: number,
  epsilonS = 1e-6,
): number | null {
  if (segmentSeconds <= 0) return null;
  const raw = startS / segmentSeconds;
  const rounded = Math.round(raw);
  if (Math.abs(raw - rounded) * segmentSeconds > epsilonS) return null;
  return Math.max(0, rounded);
}

export interface PrefetchTransport<T> {
  /** Fetch one segment. Must observe `signal` (reject/throw once it fires, or
   *  at least return promptly) so `PrefetchController.stop()` is a clean
   *  abort rather than a fire-and-forget. */
  fetchSegment(segment: number, signal: AbortSignal): Promise<{ value: T; bytes: number }>;
}

export interface PrefetchControllerOptions<T> {
  cache: ByteCappedLRUCache<T>;
  transport: PrefetchTransport<T>;
  /** Cache key for a given segment index; must be unique to the transport's
   *  current target (group, level, channel rows, segment width) so a retarget
   *  never collides with stale entries left by a previous target. */
  keyFor: (segment: number) => string;
  /** Notified after every attempted segment (hit, stored, skipped, or
   *  errored) with a snapshot of covered segment indices, so the caller can
   *  redraw a buffered-region affordance. */
  onProgress?: (covered: ReadonlySet<number>) => void;
  /** Cooperative yield point between segments (and while paused/yielding to
   *  an interactive read). Defaults to `requestIdleCallback` when available,
   *  else a short `setTimeout`. Tests inject an immediate resolver. */
  idle?: () => Promise<void>;
}

function defaultIdle(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => number })
      .requestIdleCallback;
    if (typeof ric === "function") ric(() => resolve());
    else setTimeout(resolve, 32);
  });
}

/**
 * Drives the background walk. One `PrefetchController` is created per viewer
 * mount and `retarget()`-ed (not recreated) whenever the group, view level,
 * channel-row range, or segment width changes -- see viewer.ts. `start()` and
 * `retarget()` both begin a fresh walk from a new center; `stop()` is the
 * clean-abort path wired to the viewer's destroy().
 */
export class PrefetchController<T> {
  private covered = new Set<number>();
  private abortController: AbortController | null = null;
  private generation = 0;
  private totalSegments = 0;
  private center = 0;
  private interactiveDepth = 0;
  private hidden = false;
  private runningFlag = false;

  constructor(private opts: PrefetchControllerOptions<T>) {}

  get coveredSegments(): ReadonlySet<number> {
    return this.covered;
  }

  /** True while the walk is actively progressing (not stopped, not halted by
   *  a full cache, not finished covering every segment). */
  get running(): boolean {
    return this.runningFlag;
  }

  retarget(opts: Partial<PrefetchControllerOptions<T>>): void {
    this.opts = { ...this.opts, ...opts };
  }

  /** Begin (or restart) the outward walk from the segment containing `center`
   *  across `totalSegments` segments. Resets progress tracking -- a retarget
   *  means a different target configuration, so prior coverage no longer
   *  describes what is cached under the new key namespace. */
  start(totalSegments: number, center: number): void {
    this.generation++;
    const gen = this.generation;
    this.totalSegments = totalSegments;
    this.center = center;
    this.covered = new Set();
    this.abortController?.abort();
    this.abortController = null;
    this.runningFlag = totalSegments > 0;
    void this.loop(gen);
  }

  /** Clean abort: invalidates the running loop and aborts whatever segment
   *  fetch is currently in flight. Safe to call repeatedly (e.g. viewer
   *  destroy after the loop already finished on its own). */
  stop(): void {
    this.generation++;
    this.runningFlag = false;
    this.abortController?.abort();
    this.abortController = null;
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
  }

  /** Call around an interactive read so the background walk yields for its
   *  duration; always pair with `notifyInteractiveEnd()` (a try/finally at
   *  the call site). Depth-counted so overlapping interactive reads (a fast
   *  scrub) do not let the walk resume between them. */
  notifyInteractiveStart(): void {
    this.interactiveDepth++;
  }

  notifyInteractiveEnd(): void {
    this.interactiveDepth = Math.max(0, this.interactiveDepth - 1);
  }

  private get yielding(): boolean {
    return this.hidden || this.interactiveDepth > 0;
  }

  private idle(): Promise<void> {
    return this.opts.idle?.() ?? defaultIdle();
  }

  private async loop(gen: number): Promise<void> {
    const order = outwardOrder(this.totalSegments, this.center);
    for (const seg of order) {
      // Yield to interactive reads and to a hidden tab. Re-checked every idle
      // tick rather than just once, so a long interactive session (or the tab
      // staying hidden) holds the walk rather than merely delaying it once.
      while (this.yielding) {
        if (gen !== this.generation) return;
        await this.idle();
      }
      if (gen !== this.generation) return;
      if (this.covered.has(seg)) continue;

      const key = this.opts.keyFor(seg);
      if (this.opts.cache.has(key)) {
        this.covered.add(seg);
        this.opts.onProgress?.(new Set(this.covered));
        continue;
      }
      if (this.opts.cache.remainingBytes <= 0) {
        // Already full: stop before spending a fetch on bytes we already know
        // we cannot keep (website#254 "stop rather than evict"). A segment
        // that turns out larger than the remaining headroom is still caught
        // after the fact below, since sizes are not known until fetched.
        this.runningFlag = false;
        return;
      }

      this.abortController = new AbortController();
      try {
        const { value, bytes } = await this.opts.transport.fetchSegment(
          seg,
          this.abortController.signal,
        );
        if (gen !== this.generation) return; // superseded mid-fetch; discard the result
        const stored = this.opts.cache.putIfRoom(key, value, bytes);
        if (!stored) {
          // Cap reached: stop rather than evict what the viewport is showing
          // (website#254). A later cap increase or a viewport move that frees
          // room does not auto-resume; the caller re-issues start()/retarget()
          // on the next targeting change, which is the existing trigger path.
          this.runningFlag = false;
          return;
        }
        this.covered.add(seg);
        this.opts.onProgress?.(new Set(this.covered));
      } catch (err) {
        if (gen !== this.generation) return; // stop()'s abort landing here is expected
        console.warn("[eeg-viewer] prefetch segment failed:", err);
        // One bad segment (e.g. a transient failure that exhausted store.ts's
        // own retries) should not stall preloading the rest of the recording.
      }
      await this.idle();
    }
    if (gen === this.generation) this.runningFlag = false;
  }
}
