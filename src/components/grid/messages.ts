/**
 * postMessage contract between a grid pane (iframe) and the `/grid` shell.
 *
 * Kept in its own module so `src/utils/notificationSound.ts` can import the
 * message name without pulling in any React component.
 */

/** Pane → shell: this pane wants the completion chime played. */
export const GRID_SOUND_MESSAGE = 'cloudcli:grid:sound';

/** Pane → shell: this pane navigated to a different session. */
export const GRID_SESSION_MESSAGE = 'cloudcli:grid:session';

export type GridSessionMessage = {
  type: typeof GRID_SESSION_MESSAGE;
  /** Index of the reporting pane within the grid. */
  index: number;
  /** Session now shown in that pane, or null for the empty state. */
  sessionId: string | null;
};
