import { describe, expect, it } from 'vitest'
import { pageList } from './list'

describe('paginador', () => {
  it('muestra todas las páginas si son pocas', () => {
    expect(pageList(1, 5)).toEqual([1, 2, 3, 4, 5])
  })
  it('usa elipsis con muchas páginas', () => {
    expect(pageList(1, 20)).toEqual([1, 2, '…', 20])
    expect(pageList(10, 20)).toEqual([1, '…', 9, 10, 11, '…', 20])
    expect(pageList(20, 20)).toEqual([1, '…', 19, 20])
  })
})
