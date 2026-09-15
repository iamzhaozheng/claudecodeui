import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { ArrowLeft, Columns3, Grid2x2 } from 'lucide-react';

import { detectRouterBasename } from '../../../utils/routerBasename';
import { useDeviceSettings } from '../../../hooks/useDeviceSettings';
import { playNotificationSound } from '../../../utils/notificationSound';
import { GRID_SESSION_MESSAGE, GRID_SOUND_MESSAGE } from '../messages';
import type { GridSessionMessage } from '../messages';
import { MAX_PANES, useGridLayout } from '../hooks/useGridLayout';
import { useGridSplitter } from '../hooks/useGridSplitter';

/**
 * Panes that finish together should produce one chime, not four. Wide enough to
 * swallow a cluster of near-simultaneous completions, short enough that two runs
 * finishing a second apart are still two distinct notifications.
 */
const SOUND_THROTTLE_MS = 400;

const COUNT_CHOICES = [1, 2, 3, 4];

const paneSrc = (basename: string, sessionId: string | null, index: number): string => {
  const path = sessionId ? `/embed/session/${sessionId}` : '/embed';
  return `${basename}${path}?pane=${index}`;
};

export default function GridView() {
  const { isMobile } = useDeviceSettings();

  /*
    Frozen at mount on purpose. `isMobile` tracks the live window width, so
    reading it directly would redirect mid-session the moment the window
    crossed the breakpoint — dragging the browser to a half-screen split or
    unplugging an external display would silently throw the user out of the
    grid and into whichever session the root route happened to land on.
    Whether this is a phone cannot change while the page is open; the width
    can, and a narrow window is handled by dropping to fewer columns instead.
  */
  const [startedOnMobile] = useState(() => isMobile);

  const {
    layout,
    effectiveCount,
    renderColumns,
    renderSizes,
    maxByWidth,
    srcSessions,
    setCount,
    setMode,
    setSizes,
    setPaneSession,
  } = useGridLayout();

  const { containerRef, displaySizes, isDragging, startDrag } = useGridSplitter({
    sizes: renderSizes,
    onCommit: setSizes,
  });

  // Router basename, so iframe URLs stay correct when the app is served from a
  // sub-path behind a reverse proxy.
  const basename = useMemo(() => {
    const detected = detectRouterBasename();
    return detected === '/' ? '' : detected;
  }, []);

  const lastSoundRef = useRef(0);
  const setPaneSessionRef = useRef(setPaneSession);
  setPaneSessionRef.current = setPaneSession;

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Panes are same-origin by construction; anything else is not ours.
      if (event.origin !== window.location.origin) {
        return;
      }

      // Typed as unknown-ish rather than as one message shape: `event.data` is
      // whatever the sender put there, and narrowing it to a single variant up
      // front would make the other variant's check look impossible to TS.
      const data = event.data as Partial<Omit<GridSessionMessage, 'type'>> & { type?: string } | null;
      if (!data || typeof data !== 'object') {
        return;
      }

      if (data.type === GRID_SOUND_MESSAGE) {
        // performance.now() rather than Date.now(): monotonic, so a clock
        // adjustment mid-session can't wedge the throttle open or shut.
        const now = performance.now();
        if (now - lastSoundRef.current < SOUND_THROTTLE_MS) {
          return;
        }
        lastSoundRef.current = now;
        // The shell is the document the user actually clicks, so it is the one
        // with the gesture an AudioContext needs.
        void playNotificationSound();
        return;
      }

      if (data.type === GRID_SESSION_MESSAGE && typeof data.index === 'number') {
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : null;
        setPaneSessionRef.current(data.index, sessionId);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleCount = useCallback((value: number) => setCount(value), [setCount]);

  // A phone has no room to split. Redirect only when the page opened on one:
  // resizing a desktop window narrow drops to a single column instead (see
  // `startedOnMobile`). No `replace`, so Back still returns here if it happens.
  if (startedOnMobile) {
    return <Navigate to="/" />;
  }

  const columns = renderColumns;
  const panes = Array.from({ length: effectiveCount }, (_unused, index) => index);
  const isQuad = layout.mode === 'quad' && effectiveCount === MAX_PANES;

  return (
    /*
      `fixed inset-0` rather than `h-full`, matching AppContent: `#root` only
      sets `min-height`, so a percentage height on a child resolves against auto
      and collapses the grid to its content.
    */
    <div className="fixed inset-0 flex flex-col bg-background">
      <div className="flex flex-shrink-0 items-center gap-4 border-b border-border/60 bg-background px-3 py-1.5">
        <Link
          to="/"
          title="Back to single view"
          aria-label="Back to single view"
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>

        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Columns</span>
          <div className="flex items-center gap-0.5 rounded-md bg-muted p-0.5">
            {COUNT_CHOICES.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => handleCount(value)}
                // Above what the window can fit, panes would be under 400px wide.
                disabled={value > maxByWidth}
                title={value > maxByWidth ? 'Window too narrow for this many panes' : undefined}
                className={`h-6 w-6 rounded text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  layout.count === value
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {value}
              </button>
            ))}
          </div>
        </div>

        {/* 2×2 only exists for four panes; with fewer there is no second row. */}
        {layout.count === MAX_PANES && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Layout</span>
            <div className="flex items-center gap-0.5 rounded-md bg-muted p-0.5">
              <button
                type="button"
                onClick={() => setMode('row')}
                title="Single row"
                aria-label="Single row"
                className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
                  layout.mode === 'row'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Columns3 className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setMode('quad')}
                title="2 × 2 grid"
                aria-label="2 by 2 grid"
                className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
                  layout.mode === 'quad'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Grid2x2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      <div ref={containerRef} className="relative flex min-h-0 flex-1">
        {/*
          Iframes swallow mouse events, so a drag would stop the instant the
          pointer crossed a pane boundary. This overlay sits above the panes for
          the duration of a drag so the document-level listeners keep seeing it.
        */}
        {isDragging && <div className="absolute inset-0 z-20 cursor-col-resize" />}

        {Array.from({ length: columns }, (_unused, column) => {
          // In quad mode each column holds two stacked panes; otherwise one.
          const columnPanes = isQuad
            ? panes.filter((index) => index % 2 === column)
            : [panes[column]];

          return (
            <div
              key={column}
              className="flex min-w-0 flex-col"
              style={{ width: `${(displaySizes[column] ?? 1 / columns) * 100}%` }}
            >
              {columnPanes.map((index, row) => (
                <div
                  key={index}
                  className={`min-h-0 flex-1 overflow-hidden ${
                    row > 0 ? 'border-t border-border/60' : ''
                  }`}
                >
                  <iframe
                    // `pane=N` is how the pane tags its reports back to us.
                    src={paneSrc(basename, srcSessions[index] ?? null, index)}
                    title={`Session pane ${index + 1}`}
                    className="h-full w-full border-0"
                  />
                </div>
              ))}
            </div>
          );
        })}

        {/* One handle per interior boundary; the last column has no right edge. */}
        {Array.from({ length: Math.max(columns - 1, 0) }, (_unused, boundary) => {
          const left = displaySizes
            .slice(0, boundary + 1)
            .reduce((sum, fraction) => sum + fraction, 0);

          return (
            <div
              key={boundary}
              role="separator"
              aria-orientation="vertical"
              onMouseDown={(event) => startDrag(boundary, event)}
              className="absolute inset-y-0 z-30 w-1.5 -translate-x-1/2 cursor-col-resize bg-transparent transition-colors hover:bg-primary/40"
              style={{ left: `${left * 100}%` }}
            />
          );
        })}
      </div>
    </div>
  );
}
