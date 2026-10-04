/** Minecraft material-quantity units: a stack is 64 items, a shulker
 * box ("盒") holds 27 stacks. */

const STACK = 64
const BOX = 27 * STACK

/** Format a count as compact 盒/组/个 units, omitting zero parts:
 * 1729 → "1盒1个", 64 → "1组", 7 → "7个", 0 → "0个". */
export function formatStackSize(count: number): string {
  const boxes = Math.floor(count / BOX)
  const stacks = Math.floor((count % BOX) / STACK)
  const items = count % STACK
  const parts: string[] = []
  if (boxes > 0) parts.push(`${boxes}盒`)
  if (stacks > 0) parts.push(`${stacks}组`)
  if (items > 0 || parts.length === 0) parts.push(`${items}个`)
  return parts.join('')
}
