import { useEffect, useRef, useState } from 'react'
import { Button, Sheet } from './components/ui'

/* Camera QR scanner for pairing. The QR the Mac prints holds the bare token,
   never a URL: a link would open Safari, and on iOS a home-screen web app has
   its own storage, so the token would land in the wrong one of the two — and
   Orbit has to be the installed app for push to work at all. So the camera
   opens inside Orbit and the decoded string goes straight into the field.

   Safari has no BarcodeDetector, so the decoding is jsQR's — 130KB of
   dependency-free JavaScript, 47KB over the wire. It is pulled in by a dynamic
   import from the tap that opens this sheet rather than at module scope,
   because almost every login is a paste and the decoder has no business
   sitting in the boot bundle for those. */

export const qrScanSupported = () =>
  window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function'

/** Why the button is missing — plain http on the LAN is the common case, and a
    dead button with no explanation sends people hunting for a bug that isn't one. */
export const qrScanUnavailable = () =>
  window.isSecureContext
    ? 'This browser has no camera access'
    : 'Scanning needs a secure connection (https). See docs/TAILSCALE.md.'

/* WebKit reports a refusal as a DOMException name and nothing else, so the name
   is translated into the setting the user has to go and change — the same
   treatment speech.ts gives the microphone, for the same reason: there are no
   devtools on a phone and the raw name explains nothing. */
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

interface Props {
  onResult: (token: string) => void
  onClose: () => void
}

export default function QrScanner({ onResult, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)

  /* Everything the camera holds is created and torn down inside this one
     effect, so there is exactly one place that can leak it. A stream left
     running keeps the recording indicator lit and the battery draining, and on
     iOS nothing on screen says the page is still holding it. */
  useEffect(() => {
    let stopped = false
    let frame = 0
    let stream: MediaStream | null = null
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })

    const stop = () => {
      stopped = true
      cancelAnimationFrame(frame)
      stream?.getTracks().forEach((t) => t.stop())
      stream = null
    }

    // The import and the permission request start together rather than one
    // after the other: the download is the slow half, and asking for the camera
    // first keeps the prompt inside the tap that opened the sheet.
    Promise.all([
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }),
      import('jsqr'),
    ])
      .then(async ([media, { default: jsQR }]) => {
        const video = videoRef.current
        if (stopped || !video || !ctx) {
          media.getTracks().forEach((t) => t.stop())
          return
        }
        stream = media
        video.srcObject = media
        await video.play()

        const tick = () => {
          if (stopped) return
          frame = requestAnimationFrame(tick)
          if (video.readyState < video.HAVE_CURRENT_DATA || !video.videoWidth) return

          // The frame is decoded at a fraction of its capture size. jsQR's cost
          // is per pixel, and a 1080p frame sixty times a second heats the phone
          // for no gain — a QR filling a third of the view is still tens of
          // modules across at 480px.
          const scale = Math.min(1, 480 / video.videoWidth)
          canvas.width = Math.round(video.videoWidth * scale)
          canvas.height = Math.round(video.videoHeight * scale)
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
          // Both polarities are tried because the QR is printed into a terminal,
          // and on a dark theme it comes out light-on-dark — the inverse of what
          // a decoder expects. Guessing wrong would leave half of all users
          // pointing the camera at a code that never resolves.
          const found = jsQR(image.data, image.width, image.height, {
            inversionAttempts: 'attemptBoth',
          })
          const text = found?.data.trim()
          if (!text) return
          stop()
          onResult(text)
        }
        frame = requestAnimationFrame(tick)
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
            /* Without both of these iOS takes the video fullscreen the moment it
               plays, which would hide the sheet and its cancel button. */
            playsInline
            muted
            autoPlay
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
