import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const qrcode = require('../vendor/qrcode-generator.cjs')

/** Renders `text` as a self-contained SVG QR code (dark modules on a white quiet zone). */
export function qrSvg(text, { margin = 4, errorCorrection = 'M' } = {}) {
  const qr = qrcode(0, errorCorrection)
  qr.addData(text, 'Byte')
  qr.make()
  const count = qr.getModuleCount()
  const size = count + margin * 2
  let path = ''
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) path += `M${col + margin} ${row + margin}h1v1h-1z`
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="Orca pairing QR code"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
}
