import { useEffect, useRef, useState } from 'react'
import { Button, Sheet } from './components/ui'

type QrDecoder = typeof import('jsqr').default

const DECODE_WIDTH_PX = 480

const REAR_CAMERA: MediaStreamConstraints = { video: { facingMode: 'environment' } }

const KEEP_VIDEO_INLINE_ON_IOS = { playsInline: true, muted: true, autoPlay: true } as const

export const qrScanSupported = () =>
  window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function'

export const qrScanUnavailable = () =>
  window.isSecureContext
    ? 'This browser has no camera access'
    : 'Scanning needs a secure connection (https). See docs/TAILSCALE.md.'

const cameraMessage = (err: unknown): string => {
  const name = (err as { name?: string })?.name ?? ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access denied. In Safari tap “AA” in the address bar → Website Settings → Camera → Allow, then reload. If Orbit is on the home screen, delete and re-add it after allowing.'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera available on this device'
    case 'NotReadableError':
      return 'The camera is busy — close anything else using it and try again'
    default:
      return name ? `Camera error: ${name}` : 'Could not start the camera'
  }
}

const stopTracks = (stream: MediaStream) => stream.getTracks().forEach((t) => t.stop())

const decodeDownscaledFrame = (
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  decode: QrDecoder,
): string | null => {
  const scale = Math.min(1, DECODE_WIDTH_PX / video.videoWidth)
  canvas.width = Math.round(video.videoWidth * scale)
  canvas.height = Math.round(video.videoHeight * scale)
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const found = decode(image.data, image.width, image.height, {
    inversionAttempts: 'attemptBoth',
  })
  return found?.data.trim() || null
}

interface Props {
  onResult: (token: string) => void
  onClose: () => void
}

export default function QrScanner({ onResult, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stopped = false
    let frame = 0
    let stream: MediaStream | null = null
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })

    const stop = () => {
      stopped = true
      cancelAnimationFrame(frame)
      if (stream) stopTracks(stream)
      stream = null
    }

    const frameIsReady = (video: HTMLVideoElement) =>
      video.readyState >= video.HAVE_CURRENT_DATA && video.videoWidth > 0

    Promise.all([navigator.mediaDevices.getUserMedia(REAR_CAMERA), import('jsqr')])
      .then(async ([media, { default: decode }]) => {
        const video = videoRef.current
        if (stopped || !video || !ctx) {
          stopTracks(media)
          return
        }
        stream = media
        video.srcObject = media
        await video.play()

        const scanNextFrame = () => {
          if (stopped) return
          frame = requestAnimationFrame(scanNextFrame)
          if (!frameIsReady(video)) return
          const text = decodeDownscaledFrame(video, canvas, ctx, decode)
          if (!text) return
          stop()
          onResult(text)
        }
        frame = requestAnimationFrame(scanNextFrame)
      })
      .catch((err: unknown) => {
        stop()
        setError(cameraMessage(err))
      })

    return stop
  }, [onResult])

  return (
    <Sheet title="Scan pairing code" side="full" onClose={onClose}>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 p-5">
        <div className="relative w-full max-w-xs overflow-hidden rounded-(--radius-card) border border-line bg-ink">
          <video
            ref={videoRef}
            className="aspect-square w-full object-cover"
            {...KEEP_VIDEO_INLINE_ON_IOS}
          />
          <div className="pointer-events-none absolute inset-6 rounded-xl border-2 border-accent/70" />
        </div>
        <p
          className={`max-w-xs text-center text-sm leading-relaxed ${
            error ? 'text-danger' : 'text-mut'
          }`}
        >
          {error ?? 'Point the camera at the QR code in the Orbit server console.'}
        </p>
        <Button variant="outline" className="w-full max-w-xs" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Sheet>
  )
}
