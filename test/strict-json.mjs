/** Like Orca's `z.json()` storage check: rejects undefined, functions and non-finite numbers anywhere. */
export function assertStrictJson(value, path = 'value') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (Array.isArray(value)) return value.forEach((item, i) => assertStrictJson(item, `${path}[${i}]`))
  if (value && typeof value === 'object') return Object.entries(value).forEach(([k, item]) => assertStrictJson(item, `${path}.${k}`))
  throw new Error(`${path}: Invalid input`)
}
