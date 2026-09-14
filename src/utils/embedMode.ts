/**
 * Embed mode: this document is one pane of the multi-column grid (`/grid`),
 * rendered inside an iframe rather than as the top-level app.
 *
 * Each pane is a genuinely separate document, so the flag is a property of the
 * document itself and cannot change during its lifetime — evaluating it once at
 * module load keeps every call site a plain function call, with no context to
 * thread through or props to drill.
 *
 * Behaviour that keys off this:
 *  - `useDeviceSettings` forces the mobile layout, so the sidebar becomes a
 *    drawer. A pane is typically ~860px wide, which is above the 768px
 *    breakpoint, so width alone would leave the fixed sidebar eating half the
 *    pane.
 *  - `useProjectsState` keeps navigation inside `/embed/...` and skips the
 *    origin-global localStorage keys that panes would otherwise overwrite for
 *    each other.
 *  - `notificationSound` delegates playback to the shell so four panes
 *    finishing together produce one chime instead of four.
 */

const EMBED_ROUTE_SEGMENT = /(^|\/)embed(\/|$)/;

const EMBED = typeof window !== 'undefined'
  && EMBED_ROUTE_SEGMENT.test(window.location.pathname);

export const isEmbedMode = (): boolean => EMBED;

/**
 * Which grid slot this pane occupies, from the `?pane=N` the shell puts on the
 * iframe src. The shell needs it to know which slot a session report belongs to.
 *
 * Read once at load, like the embed flag itself: the pane navigates internally
 * (picking a session, switching projects), and those paths would drop the query
 * string. A pane that forgot its own index would stop reporting, and the shell
 * would silently fail to persist which session the pane is showing.
 */
const PANE = (() => {
  if (!EMBED) {
    return null;
  }

  const raw = new URLSearchParams(window.location.search).get('pane');
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
})();

export const paneIndex = (): number | null => PANE;

/** Route prefix for the current document: `/embed` in a pane, `` at top level. */
export const routePrefix = (): string => (EMBED ? '/embed' : '');

// Keep `?pane=N` on every in-pane navigation. It is not needed for the index
// itself (captured above), but it keeps the pane's URL self-describing, so a
// reload of the iframe alone still lands in the right slot.
const paneQuery = (): string => (PANE === null ? '' : `?pane=${PANE}`);

/** Path of a session view, kept within the current document's route family. */
export const sessionPath = (sessionId: string): string => (
  `${routePrefix()}/session/${sessionId}${paneQuery()}`
);

/** Path of the "no session selected" view for the current document. */
export const rootPath = (): string => (EMBED ? `/embed${paneQuery()}` : '/');
