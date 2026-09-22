/**
 * How many characters a typing demo lays down per tick, and how long it waits
 * between them.
 *
 * Typing a character at a time reads beautifully and costs one React render per
 * character. At fourteen milliseconds a character that is seventy renders a
 * second of a panel that is decoration, and there are five of these demos on the
 * page. On a phone or a four-core laptop that is the difference between a smooth
 * scroll past the section and a stuttering one.
 *
 * So on a device that told us it is working hard, the same text arrives over the
 * same number of seconds in fewer, larger steps. The wall-clock pacing of the
 * demo is unchanged — only the number of renders it takes to get there.
 */
export function typeStep(weak, msPerChar) {
  const chars = weak ? 3 : 1;
  return { chars, delay: msPerChar * chars };
}

/** advance a character count by `chars`, never past the end */
export function advance(count, chars, length) {
  return Math.min(count + chars, length);
}
