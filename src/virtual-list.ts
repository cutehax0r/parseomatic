// Generic virtualized/windowed list: renders only the rows currently in
// (or near) the viewport, no matter how large the underlying data is --
// up to ~1.8M rows for a real combat log. Two things make this safe to
// reuse for both the async-paged raw event view and the already-in-memory
// debug tables:
//
// - `fetchRange` can return either a plain array (debug tables, slicing
//   data already held client-side) or a Promise (the raw view, paging
//   through a Tauri command) -- callers don't need two implementations.
// - Rows are *recycled*, not destroyed and recreated on every scroll:
//   `createRow` builds each DOM element once, `renderRow` just updates an
//   existing element's content in place. Less GC pressure and layout
//   thrashing during continuous fast scrolling, which is exactly the
//   interaction this is for (see docs/performance-concerns.md #1, #2).
//
// Fixed row height is the key simplifying assumption throughout -- no
// measuring, no dynamic layout, the visible range is a pure function of
// scrollTop.

export interface VirtualListOptions<T> {
  /** The scrolling element (`overflow-y: auto`). */
  container: HTMLElement;
  /** Zero-width element whose height (set here) drives the scrollbar's size/proportions. */
  spacer: HTMLElement;
  /** Where recycled row elements live, positioned via `style.top`. */
  rowsContainer: HTMLElement;
  rowHeight: number;
  /** Extra rows rendered above/below the visible range so small scrolls don't need a refetch. */
  overscan?: number;
  /** Minimum time between fetches while actively scrolling (ms). A fast drag or a "jump to row" moves the visible range on nearly every frame; without this, each of those frames fires its own `fetchRange` (an IPC round trip for an async source) that's immediately superseded by the next. Doesn't add latency once the range settles -- the final position always renders, at worst this many ms after the last scroll event. */
  minRenderIntervalMs?: number;
  /** Builds one row element. Called only when the recycle pool needs to grow. */
  createRow: () => HTMLElement;
  /** Updates an existing (possibly reused) row element's content for `item`. */
  renderRow: (item: T, el: HTMLElement, index: number) => void;
  /** Returns (or resolves to) the `count` items starting at `start`. */
  fetchRange: (start: number, count: number) => T[] | Promise<T[]>;
}

const DEFAULT_OVERSCAN = 10;
const DEFAULT_MIN_RENDER_INTERVAL_MS = 80;

// Browsers cap how tall a single element's layout box can be -- WebKit's
// practical limit is well under what a many-million-row fixture needs
// at rowHeight px/row (1.8M rows * 24px is ~43M px). Past that limit,
// `scrollTop` stops tracking drag/wheel input reliably: the scrollbar
// thumb still moves, but the value the browser reports gets clamped or
// stuck, which is exactly the "drag jumps once, then further scrolling
// gets stuck" bug this constant exists to avoid. The spacer's real DOM
// height is capped here, comfortably under that ceiling, and scrollTop
// is treated as a *proportional* position within the logical range
// rather than a literal pixel offset into it (see `renderVisible`).
const MAX_SPACER_HEIGHT = 8_000_000;

export class VirtualList<T> {
  private readonly opts: Required<VirtualListOptions<T>>;
  private pool: HTMLElement[] = [];
  private renderedStart = -1;
  private renderedEnd = -1;
  private total = 0;
  // spacerHeight / logicalHeight. 1 when the list is small enough that
  // the spacer didn't need capping -- scrollTop then equals the logical
  // position exactly, same as before this existed.
  private scale = 1;
  private scrollScheduled = false;
  // performance.now() of the last renderVisible() call triggered by
  // scrolling -- the debounce clock for onScroll (see below). Explicit
  // refreshes (setTotal/refresh) bypass this entirely; only scroll-driven
  // renders should ever be throttled.
  private lastScrollRenderAt = 0;
  // Set when a scroll arrives before minRenderIntervalMs has elapsed
  // since the last render -- guarantees the range still settles onto its
  // final position even if scroll events stop arriving mid-window.
  private trailingTimer: ReturnType<typeof setTimeout> | null = null;
  // Bumped on every fetch so a slow, superseded fetchRange response can't
  // clobber a newer one that already landed (scroll fast enough with an
  // async source and two requests can resolve out of order).
  private fetchToken = 0;

  constructor(opts: VirtualListOptions<T>) {
    this.opts = { overscan: DEFAULT_OVERSCAN, minRenderIntervalMs: DEFAULT_MIN_RENDER_INTERVAL_MS, ...opts };
    this.opts.container.addEventListener("scroll", () => this.onScroll());
  }

  /** Resizes the spacer for a new total row count and forces a fresh render. */
  setTotal(total: number): void {
    this.total = total;
    const logicalHeight = total * this.opts.rowHeight;
    const spacerHeight = Math.min(logicalHeight, MAX_SPACER_HEIGHT);
    this.scale = logicalHeight > 0 ? spacerHeight / logicalHeight : 1;
    this.opts.spacer.style.height = `${spacerHeight}px`;
    this.forceRerender();
  }

  /** Forces a re-render of the current visible range (e.g. the underlying data changed). */
  refresh(): void {
    this.forceRerender();
  }

  private forceRerender(): void {
    if (this.trailingTimer !== null) {
      clearTimeout(this.trailingTimer);
      this.trailingTimer = null;
    }
    this.renderedStart = -1;
    this.renderedEnd = -1;
    void this.renderVisible();
  }

  // Throttles renderVisible() (and the fetch it may do) to at most once
  // per minRenderIntervalMs while the user is actively scrolling, with a
  // trailing call so the final scroll position always renders. This is
  // on top of, not instead of, the rAF scheduling below -- rAF alone
  // still lets a fast drag fire a fetch on nearly every frame, since the
  // visible range keeps moving; this caps how often that fetch actually
  // happens, independent of frame rate.
  private onScroll(): void {
    const now = performance.now();
    const elapsed = now - this.lastScrollRenderAt;
    if (elapsed >= this.opts.minRenderIntervalMs) {
      this.scheduleRender();
      return;
    }
    if (this.trailingTimer === null) {
      this.trailingTimer = setTimeout(() => {
        this.trailingTimer = null;
        this.scheduleRender();
      }, this.opts.minRenderIntervalMs - elapsed);
    }
  }

  private scheduleRender(): void {
    if (this.scrollScheduled) return;
    this.scrollScheduled = true;
    requestAnimationFrame(() => {
      this.scrollScheduled = false;
      this.lastScrollRenderAt = performance.now();
      void this.renderVisible();
    });
  }

  private async renderVisible(): Promise<void> {
    const { container, rowHeight, overscan, fetchRange, renderRow, createRow, rowsContainer } = this.opts;

    if (this.total === 0) {
      for (const el of this.pool) el.style.display = "none";
      return;
    }

    // scrollTop is real DOM pixels within the (possibly capped) spacer;
    // dividing by `scale` maps it back to the logical row-space position
    // it represents proportionally.
    const logicalScrollTop = container.scrollTop / this.scale;
    const firstVisible = Math.floor(logicalScrollTop / rowHeight);
    const lastVisible = Math.ceil((logicalScrollTop + container.clientHeight) / rowHeight);
    const start = Math.max(0, firstVisible - overscan);
    const end = Math.min(this.total, lastVisible + overscan);

    if (start === this.renderedStart && end === this.renderedEnd) return;
    this.renderedStart = start;
    this.renderedEnd = end;

    const token = ++this.fetchToken;
    const result = fetchRange(start, end - start);
    const items = result instanceof Promise ? await result : result;
    if (token !== this.fetchToken) return; // superseded by a later scroll/refresh

    while (this.pool.length < items.length) {
      const el = createRow();
      rowsContainer.appendChild(el);
      this.pool.push(el);
    }

    // Rows are anchored near the real scrollTop -- not at their absolute
    // logical offset (start*rowHeight could itself be tens of millions
    // of pixels once scale < 1) -- and spaced by the true, unscaled
    // rowHeight from there. That keeps every DOM `top` value bounded
    // near the viewport, and rows exactly rowHeight apart with no
    // overlap, regardless of how large `total` is.
    const fractionalOffset = logicalScrollTop - firstVisible * rowHeight;
    const realTopOfFirstVisible = container.scrollTop - fractionalOffset * this.scale;
    const realTopOfStart = realTopOfFirstVisible - (firstVisible - start) * rowHeight;
    items.forEach((item, i) => {
      const el = this.pool[i];
      el.style.display = "";
      el.style.top = `${realTopOfStart + i * rowHeight}px`;
      renderRow(item, el, start + i);
    });

    // Pool elements beyond what this render needed just hide in place --
    // still there, ready to be repositioned/reused next time the range
    // grows back, never destroyed.
    for (let i = items.length; i < this.pool.length; i++) {
      this.pool[i].style.display = "none";
    }
  }
}
