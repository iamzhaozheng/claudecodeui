import { useCallback, useEffect, useRef, useState } from 'react';

/** A column narrower than this is useless, so a drag can't push past it. */
const MIN_FRACTION = 0.12;

type Params = {
  /** Committed column fractions, summing to 1. */
  sizes: number[];
  /** Called once on mouseup — persisting every mousemove would thrash localStorage. */
  onCommit: (sizes: number[]) => void;
};

/**
 * Drag-to-resize for the column splitters.
 *
 * Follows the same shape as `src/components/code-editor/hooks/useEditorSidebar.ts:64-106`
 * — document-level listeners so the pointer can leave the 4px handle mid-drag,
 * plus body `cursor`/`userSelect` overrides undone in cleanup. The difference is
 * that columns are fractions of the container rather than a fixed pixel width,
 * and that a drag here moves a *boundary*: it takes width from one neighbour and
 * gives exactly that much to the other, leaving every other column untouched.
 *
 * Iframes swallow mouse events, so without the overlay (see GridView) a drag
 * would die the moment the pointer crossed into a pane.
 */
export function useGridSplitter({ sizes, onCommit }: Params) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  /** Live fractions during a drag; null when idle so `sizes` is the source of truth. */
  const [preview, setPreview] = useState<number[] | null>(null);

  // Read inside document-level handlers that are bound once per drag.
  const sizesRef = useRef(sizes);
  sizesRef.current = sizes;
  const previewRef = useRef<number[] | null>(preview);
  previewRef.current = preview;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  const startDrag = useCallback((index: number, event: React.MouseEvent) => {
    event.preventDefault();
    setDragging(index);
  }, []);

  useEffect(() => {
    if (dragging === null) {
      return undefined;
    }

    const handleMouseMove = (event: globalThis.MouseEvent) => {
      const container = containerRef.current;
      if (!container) {
        return;
      }

      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) {
        return;
      }

      const base = sizesRef.current;
      // Fraction from the container's left edge to the pointer.
      const pointer = (event.clientX - rect.left) / rect.width;

      // Everything left of this boundary is fixed; the boundary can only move
      // within the pair of columns it separates.
      const before = base.slice(0, dragging).reduce((sum, n) => sum + n, 0);
      const pair = base[dragging] + base[dragging + 1];

      const lower = before + MIN_FRACTION;
      const upper = before + pair - MIN_FRACTION;
      if (upper <= lower) {
        return;
      }

      const clamped = Math.min(Math.max(pointer, lower), upper);
      const next = [...base];
      next[dragging] = clamped - before;
      next[dragging + 1] = pair - next[dragging];
      setPreview(next);
    };

    const handleMouseUp = () => {
      const pending = previewRef.current;
      if (pending) {
        onCommitRef.current(pending);
      }
      setPreview(null);
      setDragging(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [dragging]);

  return {
    containerRef,
    /** Fractions to render: the live drag preview, else the committed sizes. */
    displaySizes: preview ?? sizes,
    isDragging: dragging !== null,
    startDrag,
  };
}
