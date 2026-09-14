import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'cloudcli:grid-layout';

export const MAX_PANES = 4;
/**
 * Below this, a pane is too cramped to be worth having. Used to cap the column
 * count against the window width so the shell can't be put into a state where
 * every pane is unusable.
 */
const MIN_PANE_WIDTH = 400;

export type GridMode = 'row' | 'quad';

export type GridLayout = {
  count: number;
  mode: GridMode;
  /** Session per slot; null means the pane shows the empty state. */
  sessions: (string | null)[];
  /** Column widths as fractions summing to 1, one per column. */
  sizes: number[];
};

const evenSizes = (n: number): number[] => Array.from({ length: n }, () => 1 / n);

const DEFAULT_LAYOUT: GridLayout = {
  count: 2,
  mode: 'row',
  sessions: [null, null],
  sizes: evenSizes(2),
};

/** Columns actually rendered: `quad` is 2×2, so it is two columns of two rows. */
export const columnCount = (layout: GridLayout): number => (
  layout.mode === 'quad' ? 2 : layout.count
);

const clampCount = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isInteger(parsed)) {
    return DEFAULT_LAYOUT.count;
  }
  return Math.min(Math.max(parsed, 1), MAX_PANES);
};

/**
 * Normalize sizes to `n` fractions summing to 1. Persisted sizes can be stale
 * after a column-count change, and a malformed entry (zero, negative, NaN)
 * would otherwise collapse a pane to nothing.
 */
const normalizeSizes = (value: unknown, n: number): number[] => {
  if (!Array.isArray(value) || value.length !== n) {
    return evenSizes(n);
  }

  const numbers = value.map((entry) => (typeof entry === 'number' && entry > 0.02 ? entry : Number.NaN));
  if (numbers.some(Number.isNaN)) {
    return evenSizes(n);
  }

  const total = numbers.reduce((sum, entry) => sum + entry, 0);
  return total > 0 ? numbers.map((entry) => entry / total) : evenSizes(n);
};

const normalizeSessions = (value: unknown, n: number): (string | null)[] => {
  const source = Array.isArray(value) ? value : [];
  return Array.from({ length: n }, (_unused, index) => {
    const entry = source[index];
    return typeof entry === 'string' && entry ? entry : null;
  });
};

const readLayout = (): GridLayout => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_LAYOUT;
    }

    const parsed = JSON.parse(raw) as Partial<GridLayout>;
    const count = clampCount(parsed.count);
    // `quad` only makes sense with four panes; anything else falls back to a row.
    const mode: GridMode = parsed.mode === 'quad' && count === MAX_PANES ? 'quad' : 'row';

    const layout: GridLayout = {
      count,
      mode,
      sessions: normalizeSessions(parsed.sessions, count),
      sizes: [],
    };
    layout.sizes = normalizeSizes(parsed.sizes, columnCount(layout));
    return layout;
  } catch {
    return DEFAULT_LAYOUT;
  }
};

/**
 * Grid layout: column count, row-vs-quad arrangement, per-slot session, and
 * column widths — persisted so a refresh restores the same workspace, which is
 * the main thing browser tabs could never do.
 */
export function useGridLayout() {
  const [layout, setLayout] = useState<GridLayout>(readLayout);
  const [maxByWidth, setMaxByWidth] = useState<number>(MAX_PANES);

  useEffect(() => {
    const measure = () => {
      const fits = Math.floor(window.innerWidth / MIN_PANE_WIDTH);
      setMaxByWidth(Math.min(Math.max(fits, 1), MAX_PANES));
    };

    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // Persist on every change. Writes are small and infrequent (a drag commits
  // once on mouseup, not per mousemove).
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {
      /* localStorage unavailable — non-fatal, layout just won't survive reload */
    }
  }, [layout]);

  const setCount = useCallback((next: number) => {
    setLayout((current) => {
      const count = clampCount(next);
      if (count === current.count) {
        return current;
      }

      const updated: GridLayout = {
        count,
        mode: count === MAX_PANES ? current.mode : 'row',
        // Keep the sessions already on screen; drop the tail when shrinking.
        sessions: normalizeSessions(current.sessions, count),
        sizes: [],
      };
      updated.sizes = evenSizes(columnCount(updated));
      return updated;
    });
  }, []);

  const setMode = useCallback((mode: GridMode) => {
    setLayout((current) => {
      if (current.mode === mode || (mode === 'quad' && current.count !== MAX_PANES)) {
        return current;
      }

      const updated: GridLayout = { ...current, mode, sizes: [] };
      updated.sizes = evenSizes(columnCount(updated));
      return updated;
    });
  }, []);

  // Accepts whatever length the caller is currently rendering, which can be
  // fewer columns than `layout.sizes` holds while the width cap is active.
  const setSizes = useCallback((sizes: number[]) => {
    setLayout((current) => ({ ...current, sizes: normalizeSizes(sizes, sizes.length) }));
  }, []);

  const setPaneSession = useCallback((index: number, sessionId: string | null) => {
    setLayout((current) => {
      if (index < 0 || index >= current.count || current.sessions[index] === sessionId) {
        return current;
      }

      const sessions = [...current.sessions];
      sessions[index] = sessionId;
      return { ...current, sessions };
    });
  }, []);

  // A pane whose iframe src changes remounts and loses its scroll position and
  // in-flight state. Since a pane navigates itself and then reports back, the
  // src must stay at whatever it was first mounted with — otherwise the report
  // would feed back as a new src and remount the pane the user just used.
  const srcSessionsRef = useRef<(string | null)[]>(layout.sessions);
  const srcSessions = srcSessionsRef.current;
  if (srcSessions.length !== layout.count) {
    srcSessionsRef.current = normalizeSessions(srcSessions, layout.count);
  }

  const effectiveCount = Math.min(layout.count, maxByWidth);

  // Columns actually on screen, after the width cap. `layout.sizes` can be
  // longer (the user picked 3 columns, then narrowed the window to fit 2), and
  // rendering its first N entries verbatim would leave the dropped column's
  // share as dead space, so re-spread the surviving fractions across the width.
  const renderColumns = Math.min(columnCount(layout), effectiveCount);
  const renderSizes = layout.sizes.length === renderColumns
    ? layout.sizes
    : normalizeSizes(layout.sizes.slice(0, renderColumns), renderColumns);

  return {
    layout,
    /** Count after the width cap — what should actually be rendered. */
    effectiveCount,
    /** Number of columns on screen, and the fractions to lay them out with. */
    renderColumns,
    renderSizes,
    /** Upper bound the width allows, for disabling the count buttons. */
    maxByWidth,
    /** Stable per-pane iframe src sessions (see note above). */
    srcSessions: srcSessionsRef.current,
    setCount,
    setMode,
    setSizes,
    setPaneSession,
  };
}
