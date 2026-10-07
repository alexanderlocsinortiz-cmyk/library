import { useEffect, useRef } from 'react'

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}) {
  const cancelRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined

    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !busy) onCancel()
    }

    document.addEventListener('keydown', handleKeyDown)
    if (!busy) cancelRef.current?.focus()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [busy, onCancel, open])

  if (!open) return null

  return (
    <div className="confirm-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel() }}>
      <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-description">
        <span className={danger ? 'confirm-icon danger' : 'confirm-icon'} aria-hidden="true">!</span>
        <div className="confirm-content">
          <h2 id="confirm-dialog-title">{title}</h2>
          <p id="confirm-dialog-description">{description}</p>
        </div>
        <div className="confirm-actions">
          <button type="button" ref={cancelRef} className="secondary-button" onClick={onCancel} disabled={busy}>{cancelLabel}</button>
          <button type="button" className={danger ? 'danger-button' : 'primary-button'} onClick={onConfirm} disabled={busy}>{busy ? 'Working...' : confirmLabel}</button>
        </div>
      </section>
    </div>
  )
}
