import { describe, expect, it, vi } from 'vitest'
import {
  checkSelection,
  classifyFile,
  fitWithin,
  jpegName,
  MAX_FILE_BYTES,
  prepareUpload,
  QUALITY,
  QUALITY_SMALL,
  SOFT_LIMIT_BYTES,
  UploadError,
  type ImageCodec,
} from './image'

const file = (name: string, type: string, size = 1000) => new File([new Uint8Array(size)], name, { type })

function fakeCodec(opts: { width?: number; height?: number; fail?: boolean; sizes?: number[] } = {}) {
  const sizes = [...(opts.sizes ?? [200_000])]
  const close = vi.fn()
  const codec: ImageCodec = {
    decode: vi.fn(async () => {
      if (opts.fail) throw new Error('cannot decode')
      return { width: opts.width ?? 4000, height: opts.height ?? 3000, source: {} as CanvasImageSource, close }
    }),
    encode: vi.fn(async () => new Blob([new Uint8Array(sizes.shift() ?? 1000)], { type: 'image/jpeg' })),
  }
  return { codec, close }
}

describe('fitWithin', () => {
  it('scales the long edge down to 2000', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 2000, height: 1500 })
    expect(fitWithin(3024, 4032)).toEqual({ width: 1500, height: 2000 })
  })
  it('never upscales', () => {
    expect(fitWithin(1200, 900)).toEqual({ width: 1200, height: 900 })
    expect(fitWithin(2000, 10)).toEqual({ width: 2000, height: 10 })
  })
  it('rounds and keeps at least one pixel', () => {
    expect(fitWithin(4001, 3)).toEqual({ width: 2000, height: 1 })
    expect(fitWithin(3000, 1999)).toEqual({ width: 2000, height: 1333 })
  })
})

describe('classifyFile', () => {
  it.each([
    ['r.pdf', 'application/pdf', 'pdf'],
    ['r.PDF', '', 'pdf'],
    ['r.heic', 'image/heic', 'heic'],
    ['r.HEIF', '', 'heic'],
    ['r.jpg', 'image/jpeg', 'image'],
    ['r.png', 'image/png', 'image'],
    ['r.webp', 'image/webp', 'image'],
    ['r.jpeg', '', 'image'],
    ['notes.txt', 'text/plain', 'unsupported'],
    ['r.mov', 'video/quicktime', 'unsupported'],
  ])('%s (%s) → %s', (name, type, kind) => {
    expect(classifyFile({ name, type })).toBe(kind)
  })
})

describe('checkSelection', () => {
  it('limits to five files', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ name: `${i}.jpg`, type: 'image/jpeg' }))
    expect(checkSelection(six)).toMatch(/Up to 5/)
    expect(checkSelection(six.slice(0, 5))).toBeNull()
  })
  it('names the file it can’t take', () => {
    expect(checkSelection([{ name: 'a.jpg', type: 'image/jpeg' }, { name: 'menu.docx', type: '' }])).toMatch(/menu.docx/)
  })
})

describe('prepareUpload', () => {
  it('re-encodes photos as JPEG at the long-edge limit', async () => {
    const { codec, close } = fakeCodec({ width: 4032, height: 3024 })
    const out = await prepareUpload(file('IMG_1.png', 'image/png'), codec)
    expect(out.type).toBe('image/jpeg')
    expect(out.name).toBe('IMG_1.jpg')
    expect(codec.encode).toHaveBeenCalledTimes(1)
    expect(codec.encode).toHaveBeenCalledWith(expect.anything(), 2000, 1500, QUALITY)
    expect(close).toHaveBeenCalled()
  })

  it('drops quality when the first pass is over 1.5 MB', async () => {
    const { codec } = fakeCodec({ sizes: [SOFT_LIMIT_BYTES + 1, 900_000] })
    const out = await prepareUpload(file('big.jpg', 'image/jpeg'), codec)
    expect(codec.encode).toHaveBeenCalledTimes(2)
    expect(codec.encode).toHaveBeenLastCalledWith(expect.anything(), 2000, 1500, QUALITY_SMALL)
    expect(out.size).toBe(900_000)
  })

  it('never sends WebP', async () => {
    const { codec } = fakeCodec()
    const out = await prepareUpload(file('shot.webp', 'image/webp'), codec)
    expect(out.type).toBe('image/jpeg')
    expect(out.name).toBe('shot.jpg')
  })

  it('passes PDFs through untouched', async () => {
    const { codec } = fakeCodec()
    const pdf = file('receipt.pdf', 'application/pdf', 2_000_000)
    await expect(prepareUpload(pdf, codec)).resolves.toBe(pdf)
    expect(codec.decode).not.toHaveBeenCalled()
  })

  it('rejects PDFs over 4 MB with a friendly message', async () => {
    const { codec } = fakeCodec()
    const err = await prepareUpload(file('scan.pdf', 'application/pdf', MAX_FILE_BYTES + 1), codec).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UploadError)
    expect((err as UploadError).message).toMatch(/scan.pdf is 4.0 MB\. A PDF can be up to 4 MB/)
  })

  it('uploads HEIC as-is when the browser can’t decode it', async () => {
    const { codec } = fakeCodec({ fail: true })
    const heic = file('IMG_9.HEIC', 'image/heic')
    await expect(prepareUpload(heic, codec)).resolves.toBe(heic)
  })

  it('converts HEIC when the browser can decode it', async () => {
    const { codec } = fakeCodec()
    const out = await prepareUpload(file('IMG_9.heic', 'image/heic'), codec)
    expect(out.type).toBe('image/jpeg')
  })

  it('rejects undecodable non-HEIC images and other file types', async () => {
    const { codec } = fakeCodec({ fail: true })
    await expect(prepareUpload(file('x.png', 'image/png'), codec)).rejects.toThrow(/couldn't be opened/)
    await expect(prepareUpload(file('a.txt', 'text/plain'), codec)).rejects.toThrow(/isn't a photo or a PDF/)
    await expect(prepareUpload(file('e.jpg', 'image/jpeg', 0), codec)).rejects.toThrow(/empty/)
  })
})

describe('jpegName', () => {
  it('swaps the extension', () => {
    expect(jpegName('a.b.png')).toBe('a.b.jpg')
    expect(jpegName('photo')).toBe('photo.jpg')
    expect(jpegName('.png')).toBe('receipt.jpg')
  })
})
