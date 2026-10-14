/**
 * Reads one pixel's colour from a PNG screenshot, so a test can check the
 * screenshot shows the page as drawn and not just its text.
 *
 *   pixelAt(png, 260, 320)   → { red: 68, green: 170, blue: 119 }
 *
 * Handles what browsers write: 8 bits per channel, RGB or RGBA, not interlaced.
 *
 * Used by: actions.ts
 */
import { inflateSync } from "node:zlib"

export interface Colour {
  red: number
  green: number
  blue: number
}

export function pixelAt(png: Buffer, x: number, y: number): Colour {
  // After the 8-byte signature, chunks: length, type, data, checksum.
  let width = 0
  let channels = 0
  const compressed: Buffer[] = []
  let offset = 8
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString("ascii", offset + 4, offset + 8)
    const data = png.subarray(offset + 8, offset + 8 + length)
    if (type === "IHDR") {
      width = data.readUInt32BE(0)
      const bitDepth = data[8]
      const colourType = data[9]
      if (bitDepth !== 8 || (colourType !== 2 && colourType !== 6)) {
        throw new Error(`Can't read this PNG (bit depth ${bitDepth}, colour type ${colourType})`)
      }
      channels = colourType === 6 ? 4 : 3
    } else if (type === "IDAT") {
      compressed.push(data)
    }
    offset += 12 + length
  }

  // Each row starts with a filter byte; undo the filters row by row down to `y`.
  const raw = inflateSync(Buffer.concat(compressed))
  const rowBytes = width * channels
  let previous: Buffer = Buffer.alloc(rowBytes)
  let row: Buffer = Buffer.alloc(rowBytes)
  for (let line = 0; line <= y; line++) {
    const start = line * (rowBytes + 1)
    const filter = raw[start]
    row = Buffer.alloc(rowBytes)
    for (let i = 0; i < rowBytes; i++) {
      const value = raw[start + 1 + i] ?? 0
      const left = i >= channels ? (row[i - channels] ?? 0) : 0
      const up = previous[i] ?? 0
      const upLeft = i >= channels ? (previous[i - channels] ?? 0) : 0
      let predicted = 0
      if (filter === 1) {
        predicted = left
      } else if (filter === 2) {
        predicted = up
      } else if (filter === 3) {
        predicted = Math.floor((left + up) / 2)
      } else if (filter === 4) {
        predicted = paeth(left, up, upLeft)
      }
      row[i] = (value + predicted) & 0xff
    }
    previous = row
  }
  const at = x * channels
  return { red: row[at] ?? 0, green: row[at + 1] ?? 0, blue: row[at + 2] ?? 0 }
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft
  const toLeft = Math.abs(estimate - left)
  const toUp = Math.abs(estimate - up)
  const toUpLeft = Math.abs(estimate - upLeft)
  if (toLeft <= toUp && toLeft <= toUpLeft) {
    return left
  }
  if (toUp <= toUpLeft) {
    return up
  }
  return upLeft
}
