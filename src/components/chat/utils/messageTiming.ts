import type { ChatMessage } from '../types/types';

/** Parse any of the timestamp shapes a ChatMessage can carry into epoch ms. */
export function toEpochMs(timestamp: ChatMessage['timestamp'] | null | undefined): number | null {
  if (timestamp === null || timestamp === undefined || timestamp === '') {
    return null;
  }

  const parsed = timestamp instanceof Date ? timestamp.getTime() : new Date(timestamp).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Compact duration label: `1.4s`, `42s`, `3m42s`, `1h04m`.
 *
 * Sub-minute gaps keep a decimal below 10s because the interesting turns are
 * often the very short ones, where "0s" would read as "nothing happened".
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '';
  }

  const totalSeconds = ms / 1000;
  if (totalSeconds < 10) {
    return `${totalSeconds.toFixed(1)}s`;
  }

  // Round to whole seconds first, so 59.6s becomes 1m00s rather than "60s".
  const roundedSeconds = Math.round(totalSeconds);
  if (roundedSeconds < 60) {
    return `${roundedSeconds}s`;
  }

  const totalMinutes = Math.floor(roundedSeconds / 60);
  const seconds = roundedSeconds - totalMinutes * 60;
  if (totalMinutes < 60) {
    return `${totalMinutes}m${String(seconds).padStart(2, '0')}s`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes - hours * 60;
  return `${hours}h${String(minutes).padStart(2, '0')}m`;
}

/** Full local date+time for the hover/long-press tooltip. */
export function formatAbsolute(timestamp: ChatMessage['timestamp']): string {
  const ms = toEpochMs(timestamp);
  return ms === null ? '' : new Date(ms).toLocaleString();
}

/**
 * How long the provider took to produce this reply.
 *
 * Measured from the user turn that started the run to this message. Only the
 * last message of an assistant run gets one (see `isRunEnd` in the pane), so a
 * long answer split across dozens of streamed rows reports one honest total
 * rather than a badge per fragment.
 */
export function formatTurnDuration(
  startedAt: ChatMessage['timestamp'] | null | undefined,
  endedAt: ChatMessage['timestamp'] | null | undefined,
): string {
  const start = toEpochMs(startedAt);
  const end = toEpochMs(endedAt);
  if (start === null || end === null || end < start) {
    return '';
  }
  return formatDuration(end - start);
}
