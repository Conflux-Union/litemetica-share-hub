import { describe, expect, it } from 'vitest'
import type { PreviewData } from '../types'
import { decodePreviewData } from './decode'
import { formatState, parseState } from './model'

describe('schema-1 previews (bare block-id palette)', () => {
  it('decodes bare ids as property-less state strings', () => {
    // Stored schema-1 previews have no `schema` field at all.
    const preview: PreviewData = {
      size: [2, 1, 1],
      regions: [
        {
          name: 'main',
          pos: [0, 0, 0],
          size: [2, 1, 1],
          palette: ['minecraft:stone', 'minecraft:redstone_wire'],
          rle: [
            [0, 1],
            [1, 1],
          ],
        },
      ],
    }
    const grid = decodePreviewData(preview)
    expect(grid.palette).toEqual(['minecraft:air', 'minecraft:stone', 'minecraft:redstone_wire'])
    expect(Array.from(grid.data)).toEqual([1, 2])
    // Bare ids are valid state strings for the model layer.
    const state = parseState(grid.palette[2])
    expect(state).toEqual({ name: 'minecraft:redstone_wire', props: {} })
    expect(formatState(state)).toBe('minecraft:redstone_wire')
  })
})

describe('schema-2 previews (full state-string palette)', () => {
  it('keeps state strings verbatim so states share resolution cache keys', () => {
    const stateKey = 'minecraft:redstone_wire[east=none,north=up,power=7,south=none,west=none]'
    const preview: PreviewData = {
      schema: 2,
      size: [1, 1, 2],
      regions: [
        {
          name: 'main',
          pos: [0, 0, 0],
          size: [1, 1, 2],
          palette: [stateKey],
          rle: [[0, 2]],
        },
      ],
    }
    const grid = decodePreviewData(preview)
    expect(grid.palette[1]).toBe(stateKey)
    expect(parseState(grid.palette[1]).props.power).toBe('7')
    expect(Array.from(grid.data)).toEqual([1, 1])
  })
})
