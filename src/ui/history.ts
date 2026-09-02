// Per-window selection history -- every distinct range/encounter the user
// picks is pushed onto a stack; Back / Forward (toolbar + the native
// History menu) navigate it, and the toolbar's history popup lists the
// lot. Browser-history semantics: picking something new after going Back
// discards the forward entries.
//
// Per-window, because each window is its own webview / JS module context
// (same as the range store in ./context). `HistoryEntry` is deliberately
// open -- `view` / `filters` join it when "view changes in the history"
// gets built (see docs/ui-widgets.md).
//
// This module records and navigates; it does not itself apply a range to
// the UI. main.ts injects that via `configureHistory` (it routes through
// the encounter picker's `applySelection` so the picker label/highlight
// stay in sync on Back/Forward). `push`/`reset` are record-only -- their
// caller has already applied the range.

import type { RangeSelection } from "../types";

export interface HistoryEntry {
  range: RangeSelection;
  label: string;
}

export interface HistoryState {
  entries: HistoryEntry[];
  cursor: number;
  canBack: boolean;
  canForward: boolean;
}

const MAX_ENTRIES = 200;

let entries: HistoryEntry[] = [];
let cursor = -1;
let applyRange: (range: RangeSelection) => void = () => {};
const subs = new Set<(s: HistoryState) => void>();

export function configureHistory(apply: (range: RangeSelection) => void): void {
  applyRange = apply;
}

function rangesEqual(a: RangeSelection, b: RangeSelection): boolean {
  if (a.startMs !== b.startMs || a.endMs !== b.endMs || a.source.kind !== b.source.kind) {
    return false;
  }
  return a.source.kind === "encounter" && b.source.kind === "encounter"
    ? a.source.index === b.source.index
    : true;
}

export function historyState(): HistoryState {
  return {
    entries,
    cursor,
    canBack: cursor > 0,
    canForward: cursor >= 0 && cursor < entries.length - 1,
  };
}

function notify(): void {
  const s = historyState();
  for (const fn of subs) fn(s);
}

export function subscribeHistory(fn: (s: HistoryState) => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

// The user picked something and it's already been applied -- record it.
// No-op (bar a label refresh) if it's the range we're already on;
// otherwise truncate any forward entries and push.
export function pushHistory(range: RangeSelection, label: string): void {
  if (cursor >= 0 && rangesEqual(entries[cursor].range, range)) {
    entries[cursor].label = label; // label can shift (e.g. "Full log" <-> a range)
    notify();
    return;
  }
  entries = entries.slice(0, cursor + 1);
  entries.push({ range, label });
  if (entries.length > MAX_ENTRIES) entries = entries.slice(entries.length - MAX_ENTRIES);
  cursor = entries.length - 1;
  notify();
}

// New log -- drop everything, seed with the (already-applied) selection.
export function resetHistory(range: RangeSelection, label: string): void {
  entries = [{ range, label }];
  cursor = 0;
  notify();
}

function goto(next: number): void {
  if (next < 0 || next >= entries.length || next === cursor) return;
  cursor = next;
  applyRange(entries[cursor].range);
  notify();
}

export function historyBack(): void {
  goto(cursor - 1);
}

export function historyForward(): void {
  goto(cursor + 1);
}

export function historyGoto(index: number): void {
  goto(index);
}

// Keep only the current entry.
export function clearHistory(): void {
  if (cursor < 0) return;
  entries = [entries[cursor]];
  cursor = 0;
  notify();
}
