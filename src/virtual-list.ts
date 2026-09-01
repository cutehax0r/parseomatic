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
  /** Builds one row element. Called only when the recycle pool needs to grow. */
  createRow: () => HTMLElement;
  /** Updates an existing (possibly reused) row element's content for `item`. */
  renderRow: (item: T, el: HTMLElement, index: number) => void;
  /** Returns (or resolves to) the `count` items starting at `start`. */
  fetchRange: (start: number, count: number) => T[] | Promise<T[]>;
}

const DEFAULT_OVERSCAN = 10;

export class VirtualList<T> {
  private readonly opts: Required<VirtualListOptions<T>>;
  private pool: HTMLElement[] = [];
  private renderedStart = -1;
  private renderedEnd = -1;
  private total = 0;
  private scrollScheduled = false;
  // Bumped on every fetch so a slow, superseded fetchRange response can't
  // clobber a newer one that already landed (scroll fast enough with an
  // async source and two requests can resolve out of order).
  private fetchToken = 0;

  constructor(opts: VirtualListOptions<T>) {
    this.opts = { overscan: DEFAULT_OVERSCAN, ...opts };
    this.opts.container.addEventListener("scroll", () => this.onScroll());
  }

  /** Resizes the spacer for a new total row count and forces a fresh render. */
  setTotal(total: number): void {
    this.total = total;
    this.opts.spacer.style.height = `${total * this.opts.rowHeight}px`;
    this.forceRerender();
  }

  /** Forces a re-render of the current visible range (e.g. the underlying data changed). */
  refresh(): void {
    this.forceRerender();
  }

  private forceRerender(): void {
    this.renderedStart = -1;
    this.renderedEnd = -1;
    void this.renderVisible();
  }

  private onScroll(): void {
    if (this.scrollScheduled) return;
    this.scrollScheduled = true;
    requestAnimationFrame(() => {
      this.scrollScheduled = false;
      void this.renderVisible();
    });
  }

  private async renderVisible(): Promise<void> {
    const { container, rowHeight, overscan, fetchRange, renderRow, createRow, rowsContainer } = this.opts;

    if (this.total === 0) {
      for (const el of this.pool) el.style.display = "none";
      return;
    }

    const firstVisible = Math.floor(container.scrollTop / rowHeight);
    const lastVisible = Math.ceil((container.scrollTop + container.clientHeight) / rowHeight);
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

    items.forEach((item, i) => {
      const el = this.pool[i];
      el.style.display = "";
      el.style.top = `${(start + i) * rowHeight}px`;
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
