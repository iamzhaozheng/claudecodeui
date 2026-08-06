/**
 * True while an IME (Chinese/Japanese/Korean input) is composing.
 *
 * During composition the candidate window owns the keyboard: Enter commits the
 * highlighted candidate and digits pick one. Any handler that treats those keys
 * as "submit" or "choose option" fires while the user is still mid-word — so
 * every such handler must bail out when this returns true.
 *
 * `keyCode === 229` is the legacy signal browsers send for composition keys and
 * covers engines that don't set `isComposing` on every event.
 */
export function isImeComposing(
  event: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>,
): boolean {
  return event.isComposing || event.keyCode === 229;
}

/**
 * React wrapper for {@link isImeComposing}; reads the underlying native event.
 */
export function isImeComposingReact(event: {
  nativeEvent: KeyboardEvent;
  keyCode?: number;
}): boolean {
  return event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
}
