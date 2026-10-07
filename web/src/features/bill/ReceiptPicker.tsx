import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@/components/Icon'
import { ACCEPT, checkSelection, classifyFile, MAX_FILES } from '@/lib/image'
import { cn } from '@/lib/cn'

interface Thumb {
  file: File
  url: string | null
  kind: ReturnType<typeof classifyFile>
}

/** Object URLs for image previews, revoked when the selection changes. */
function useThumbs(files: File[]): Thumb[] {
  const thumbs = useMemo(
    () =>
      files.map((file) => {
        const kind = classifyFile(file)
        return { file, kind, url: kind === 'image' ? URL.createObjectURL(file) : null }
      }),
    [files],
  )
  useEffect(() => () => thumbs.forEach((t) => t.url && URL.revokeObjectURL(t.url)), [thumbs])
  return thumbs
}

/**
 * Photos or a PDF of one receipt: camera on phones, files everywhere, up to five.
 * Controlled: the parent owns `files` and gets every change.
 */
export function ReceiptPicker({
  files,
  onChange,
  disabled,
}: {
  files: File[]
  onChange: (files: File[]) => void
  disabled?: boolean
}) {
  const camera = useRef<HTMLInputElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const thumbs = useThumbs(files)
  const full = files.length >= MAX_FILES

  const add = (list: FileList | null) => {
    if (!list || list.length === 0) return
    const next = [...files, ...Array.from(list)]
    const msg = checkSelection(next)
    setProblem(msg)
    if (!msg) onChange(next)
  }

  return (
    <div
      className="flex flex-col gap-4"
      onDragOver={(e) => {
        if (disabled || full) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        if (!disabled && !full) add(e.dataTransfer.files)
      }}
    >
      <div className="grid gap-2.5 pointer-coarse:sm:grid-cols-2">
        <button
          type="button"
          disabled={disabled || full}
          onClick={() => camera.current?.click()}
          className={cn(
            'hidden h-14 items-center justify-between rounded-[var(--radius-control)] px-[18px] text-[17px] font-bold pointer-coarse:flex',
            files.length ? 'border-[1.5px] border-ink text-ink' : 'bg-cobalt text-white hover:bg-cobalt-ink',
            'disabled:border-rule-2 disabled:bg-mist-2 disabled:text-ink-2',
          )}
        >
          {files.length ? 'Take another photo' : 'Take a photo'}
          <Icon name="scan" size={22} />
        </button>
        <button
          type="button"
          disabled={disabled || full}
          onClick={() => picker.current?.click()}
          className={cn(
            'flex h-14 items-center justify-between rounded-[var(--radius-control)] border-[1.5px] border-ink px-[18px] text-[17px] font-semibold text-ink hover:bg-mist disabled:border-rule-2 disabled:text-ink-2',
            'pointer-fine:h-36 pointer-fine:flex-col pointer-fine:justify-center pointer-fine:gap-2 pointer-fine:border-dashed pointer-fine:border-rule-2 pointer-fine:hover:border-ink',
            dragging && 'border-cobalt bg-cobalt-soft pointer-fine:border-cobalt',
          )}
        >
          <span className="pointer-fine:order-2">Choose photos or a PDF</span>
          <Icon name="upload" size={22} />
          <span className="hidden text-[15px] font-medium text-ink-2 pointer-fine:order-3 pointer-fine:block">or drop them here</span>
        </button>
      </div>
      <input ref={camera} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => { add(e.target.files); e.target.value = '' }} />
      <input ref={picker} type="file" accept={ACCEPT} multiple className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => { add(e.target.files); e.target.value = '' }} />

      {problem && (
        <p role="alert" className="text-[15px] font-semibold text-danger">
          {problem}
        </p>
      )}

      {thumbs.length > 0 && (
        <ul aria-label="Receipt pages" className="grid grid-cols-3 gap-2.5 sm:grid-cols-5">
          {thumbs.map((t, i) => (
            <li key={`${t.file.name}-${t.file.size}-${i}`} className="relative">
              <div className="grid aspect-[3/4] place-items-center overflow-hidden rounded-[var(--radius-control)] border border-rule bg-mist">
                {t.url ? (
                  <img src={t.url} alt={`Page ${i + 1}`} className="h-full w-full object-cover" />
                ) : (
                  <span className="flex flex-col items-center gap-1 px-2 text-center text-[14px] font-semibold text-ink-2">
                    <Icon name={t.kind === 'pdf' ? 'bill' : 'photo'} size={24} />
                    <span className="max-w-full truncate">{t.kind === 'pdf' ? 'PDF' : t.file.name}</span>
                  </span>
                )}
              </div>
              <button
                type="button"
                disabled={disabled}
                aria-label={`Remove page ${i + 1}`}
                onClick={() => {
                  setProblem(null)
                  onChange(files.filter((_, j) => j !== i))
                }}
                className="absolute -right-1.5 -top-1.5 grid h-11 w-11 place-items-center"
              >
                <span className="grid h-7 w-7 place-items-center rounded-full bg-ink text-white">
                  <Icon name="close" size={16} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
