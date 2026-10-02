/**
 * Boolean attributes on custom elements: Vue falls back to setAttribute when
 * the element has no matching DOM property, turning `false` into the truthy
 * string "false". Mapping false to undefined removes the attribute instead.
 */
export function boolAttr(v: boolean | undefined): true | undefined {
  return v ? true : undefined
}
