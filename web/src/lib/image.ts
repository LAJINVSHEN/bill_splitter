/**
 * Receipt uploads, prepared in the browser before they leave the phone.
 *
 * - Photos are decoded with EXIF orientation applied, scaled so the long edge is ≤ 2000 px and
 *   re-encoded as JPEG (0.82, or 0.7 when the first pass is over 1.5 MB). Re-encoding also strips
 *   location metadata. Never WebP: Azure Document Intelligence rejects it.
 * - HEIC/HEIF the browser can't decode goes up as-is (the backend accepts HEIF).
 * - PDFs pass through untouched; the OCR tier takes at most 4 MB per file.
 */

export const MAX_FILES = 5
export const MAX_FILE_BYTES = 4 * 1024 * 1024
export const MAX_EDGE = 2000
export const QUALITY = 0.82
export const QUALITY_SMALL = 0.7
export const SOFT_LIMIT_BYTES = 1.5 * 1024 * 1024

/** What the file picker accepts. Listing HEIC explicitly keeps iOS from converting it first. */
export const ACCEPT = 'image/*,application/pdf,.pdf,.heic,.heif'

export type UploadKind = 'pdf' | 'heic' | 'image' | 'unsupported'

/** A file we can't send, with a message written for the person holding the phone. */
export class UploadError extends Error {
  readonly fileName: string
  constructor(fileName: string, message: string) {
    super(message)
    this.fileName = fileName
  }
}

const ext = (name: string) => name.toLowerCase().split('.').pop() ?? ''

/** Route a picked file by MIME type, falling back to the extension (some Android pickers send none). */
export function classifyFile(file: Pick<File, 'name' | 'type'>): UploadKind {
  const type = file.type.toLowerCase()
  const e = ext(file.name)
  if (type === 'application/pdf' || e === 'pdf') return 'pdf'
  if (type === 'image/heic' || type === 'image/heif' || e === 'heic' || e === 'heif') return 'heic'
  if (type.startsWith('image/')) return 'image'
  if (!type && ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(e)) return 'image'
  return 'unsupported'
}

/** Scale (w, h) so the long edge is at most `max`; never upscales. Whole pixels, at least 1. */
export function fitWithin(width: number, height: number, max = MAX_EDGE): { width: number; height: number } {
  const long = Math.max(width, height)
  if (long <= max) return { width, height }
  const scale = max / long
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

export const jpegName = (name: string) => `${name.replace(/\.[^./\\]+$/, '') || 'receipt'}.jpg`

export const formatBytes = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

/** The browser bits, injectable so the routing and sizing can be tested without a canvas. */
export interface ImageCodec {
  /** Decode with EXIF orientation applied; throws when the browser can't read the format. */
  decode(file: Blob): Promise<{ width: number; height: number; source: CanvasImageSource; close?: () => void }>
  encode(source: CanvasImageSource, width: number, height: number, quality: number): Promise<Blob>
}

export const browserCodec: ImageCodec = {
  async decode(file) {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    return { width: bitmap.width, height: bitmap.height, source: bitmap, close: () => bitmap.close() }
  },
  async encode(source, width, height, quality) {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas unavailable')
    // JPEG has no alpha: paint white first so transparent PNGs don't turn black
    ctx.fillStyle = 'white'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(source, 0, 0, width, height)
    return new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('encode failed'))), 'image/jpeg', quality),
    )
  },
}

function tooBig(file: File, what: string): UploadError {
  return new UploadError(file.name, `${file.name} is ${formatBytes(file.size)}. ${what} can be up to 4 MB.`)
}

/** One picked file → the file to upload. Throws UploadError with a friendly message. */
export async function prepareUpload(file: File, codec: ImageCodec = browserCodec): Promise<File> {
  const kind = classifyFile(file)
  if (kind === 'unsupported') throw new UploadError(file.name, `${file.name} isn't a photo or a PDF.`)
  if (file.size === 0) throw new UploadError(file.name, `${file.name} is empty.`)
  if (kind === 'pdf') {
    if (file.size > MAX_FILE_BYTES) throw tooBig(file, 'A PDF')
    return file.type === 'application/pdf' ? file : new File([file], file.name, { type: 'application/pdf' })
  }

  let decoded: Awaited<ReturnType<ImageCodec['decode']>>
  try {
    decoded = await codec.decode(file)
  } catch {
    if (kind === 'heic') {
      // Most desktop browsers can't decode HEIC; the server can.
      if (file.size > MAX_FILE_BYTES) throw tooBig(file, 'A photo')
      return file.type ? file : new File([file], file.name, { type: 'image/heic' })
    }
    throw new UploadError(file.name, `${file.name} couldn't be opened. Try a JPEG or PNG.`)
  }

  try {
    const { width, height } = fitWithin(decoded.width, decoded.height)
    let blob = await codec.encode(decoded.source, width, height, QUALITY)
    if (blob.size > SOFT_LIMIT_BYTES) blob = await codec.encode(decoded.source, width, height, QUALITY_SMALL)
    if (blob.size > MAX_FILE_BYTES) throw tooBig(new File([blob], file.name), 'A photo')
    return new File([blob], jpegName(file.name), { type: 'image/jpeg', lastModified: Date.now() })
  } finally {
    decoded.close?.()
  }
}

/** Check a picked set before any work: count and kind. Returns a message, or null when it's fine. */
export function checkSelection(files: ReadonlyArray<Pick<File, 'name' | 'type'>>): string | null {
  if (files.length > MAX_FILES) return `Up to ${MAX_FILES} photos or PDFs per receipt.`
  const bad = files.find((f) => classifyFile(f) === 'unsupported')
  return bad ? `${bad.name} isn't a photo or a PDF.` : null
}
