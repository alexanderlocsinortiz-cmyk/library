import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CameraBarcodeScanner } from './CameraBarcodeScanner'

const { mockDecodeFromVideoDevice, mockListVideoInputDevices, mockReset, mockStop } = vi.hoisted(() => ({
  mockDecodeFromVideoDevice: vi.fn(),
  mockListVideoInputDevices: vi.fn(),
  mockReset: vi.fn(),
  mockStop: vi.fn(),
}))
const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')

vi.mock('@zxing/browser', () => ({
  BrowserMultiFormatReader: class {
    decodeFromVideoDevice(...args) { return mockDecodeFromVideoDevice(...args) }
    listVideoInputDevices() { return mockListVideoInputDevices() }
    reset() { mockReset() }
  },
}))

describe('CameraBarcodeScanner', () => {
  let decodeCallback

  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn() } })
    mockStop.mockResolvedValue(undefined)
    mockListVideoInputDevices.mockResolvedValue([
      { deviceId: 'laptop-camera', label: 'Integrated camera' },
      { deviceId: 'usb-camera', label: 'USB camera' },
    ])
    mockDecodeFromVideoDevice.mockImplementation((_device, _video, callback) => {
      decodeCallback = callback
      return Promise.resolve({ stop: mockStop })
    })
  })

  afterEach(() => {
    cleanup()
    if (originalMediaDevices) Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices)
    else delete navigator.mediaDevices
  })

  it('starts only after a click and sends a decoded barcode to the field', async () => {
    const onScan = vi.fn()
    render(<CameraBarcodeScanner onScan={onScan} />)

    expect(mockDecodeFromVideoDevice).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Scan with camera' }))
    expect(await screen.findByText(/Live preview started/)).toBeInTheDocument()
    expect(mockDecodeFromVideoDevice).toHaveBeenCalledOnce()

    decodeCallback({ getText: () => '  BC-105  ' })
    expect(onScan).toHaveBeenCalledWith('BC-105')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(mockStop).toHaveBeenCalled()
  })

  it('stops the camera when the scanner is closed', async () => {
    render(<CameraBarcodeScanner onScan={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Scan with camera' }))
    expect(await screen.findByText(/Live preview started/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close camera scanner' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(mockStop).toHaveBeenCalled()
    expect(mockReset).toHaveBeenCalled()
  })

  it('explains when the browser denies camera permission', async () => {
    mockDecodeFromVideoDevice.mockRejectedValueOnce({ name: 'NotAllowedError' })
    render(<CameraBarcodeScanner onScan={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Scan with camera' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/Camera access was blocked/)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('lets staff switch to another camera when several are available', async () => {
    render(<CameraBarcodeScanner onScan={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Scan with camera' }))
    const cameraSelect = await screen.findByRole('combobox', { name: 'Choose camera' })
    expect(cameraSelect).toHaveValue('laptop-camera')

    fireEvent.change(cameraSelect, { target: { value: 'usb-camera' } })
    await waitFor(() => expect(mockDecodeFromVideoDevice).toHaveBeenCalledTimes(2))
    expect(mockDecodeFromVideoDevice.mock.calls[1][0]).toBe('usb-camera')
    expect(mockStop).toHaveBeenCalled()
  })
})
