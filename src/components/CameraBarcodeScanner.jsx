import { useEffect, useRef, useState } from 'react'
import { Dialog } from '@mui/material'
import { BrowserMultiFormatReader } from '@zxing/browser'

function cameraErrorMessage(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
    return 'Camera access was blocked. Allow camera access in your browser settings, or enter the barcode manually.'
  }
  if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') {
    return 'No camera was found. Connect a camera or enter the barcode manually.'
  }
  if (error?.name === 'NotReadableError' || error?.name === 'TrackStartError') {
    return 'The camera is already in use by another app. Close that app and try again.'
  }
  if (error?.name === 'OverconstrainedError') {
    return 'The camera could not use the requested settings. Try another camera or enter the barcode manually.'
  }
  return 'Unable to start the camera. Check browser permissions and try again, or enter the barcode manually.'
}

export function CameraBarcodeScanner({ onScan }) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [cameraDevices, setCameraDevices] = useState([])
  const [selectedCameraId, setSelectedCameraId] = useState('')
  const [cameraRestartKey, setCameraRestartKey] = useState(0)
  const videoRef = useRef(null)
  const preferredCameraIdRef = useRef('')
  const onScanRef = useRef(onScan)
  onScanRef.current = onScan

  useEffect(() => {
    if (!open) return undefined

    let stopped = false
    let controls
    const reader = new BrowserMultiFormatReader()
    setStatus('Starting camera…')
    setError('')

    const startCamera = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Camera scanning requires HTTPS or localhost and a browser with camera support. You can still enter the barcode manually.')
        return
      }

      try {
        const cameraControls = await reader.decodeFromVideoDevice(preferredCameraIdRef.current || undefined, videoRef.current, (result) => {
          if (!result || stopped) return
          const value = result.getText().trim()
          if (!value) return
          stopped = true
          void controls?.stop()
          onScanRef.current(value)
          setOpen(false)
        })
        controls = cameraControls
        if (stopped) {
          void controls.stop()
          return
        }
        const activeDeviceId = videoRef.current?.srcObject?.getVideoTracks?.()[0]?.getSettings?.().deviceId
        try {
          const devices = await reader.listVideoInputDevices()
          if (!stopped) {
            setCameraDevices(devices)
            const activeId = devices.some((device) => device.deviceId === activeDeviceId)
              ? activeDeviceId
              : devices[0]?.deviceId || ''
            if (!preferredCameraIdRef.current) preferredCameraIdRef.current = activeId
            setSelectedCameraId(preferredCameraIdRef.current || activeId)
          }
        } catch {
          // Keep the current preview available if the browser blocks device enumeration.
        }
        if (!stopped) setStatus('Live preview started. If it stays black, select another camera or open the camera privacy shutter.')
      } catch (cameraError) {
        if (!stopped) setError(cameraErrorMessage(cameraError))
      }
    }

    void startCamera()
    return () => {
      stopped = true
      void controls?.stop()
      reader.reset()
    }
  }, [open, cameraRestartKey])

  const changeCamera = (event) => {
    preferredCameraIdRef.current = event.target.value
    setSelectedCameraId(event.target.value)
    setStatus('Switching camera…')
    setCameraRestartKey((current) => current + 1)
  }

  return <>
    <button type="button" className="camera-scan-trigger" onClick={() => setOpen(true)}>Scan with camera</button>
    <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="sm" aria-labelledby="camera-scan-title" slotProps={{ paper: { className: 'camera-scan-dialog' } }}>
        <div className="camera-scan-heading">
          <div><span className="eyebrow">Barcode input</span><h2 id="camera-scan-title">Scan with your camera</h2></div>
          <button type="button" className="camera-scan-close" aria-label="Close camera scanner" onClick={() => setOpen(false)}>×</button>
        </div>
        <p className="muted">Allow camera access when your browser asks. Hold the printed barcode steady inside the frame.</p>
        {cameraDevices.length > 1 && <label className="camera-scan-device-field">Camera<select aria-label="Choose camera" value={selectedCameraId} onChange={changeCamera}>{cameraDevices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}</select></label>}
        <div className="camera-scan-preview">
          <video ref={videoRef} autoPlay muted playsInline aria-label="Live camera preview for barcode scanning" />
          <span className="camera-scan-guide" aria-hidden="true" />
        </div>
        <p className={error ? 'inline-error camera-scan-status' : 'camera-scan-status'} role={error ? 'alert' : 'status'}>{error || status}</p>
        <div className="camera-scan-actions">
          <button type="button" className="secondary-button" onClick={() => setOpen(false)}>Close scanner</button>
        </div>
        <small className="form-helper">Camera access works on localhost or an HTTPS site. Your camera is used only while this scanner is open.</small>
    </Dialog>
  </>
}
