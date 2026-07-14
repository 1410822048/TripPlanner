import { useEffect, useRef, useState } from 'react'
import { Camera, QrCode, RotateCcw } from 'lucide-react'
import BottomSheet from '@/components/ui/BottomSheet'
import InviteRedeemPanel from './InviteRedeemPanel'
import { parseInviteUrl, type ParsedInviteUrl } from './inviteUrl'

const SCAN_INTERVAL_MS = 240
const MAX_SCAN_EDGE = 720
const NATIVE_DETECT_ERROR_LIMIT = 3
const DEFAULT_SCAN_HINT = '請將 QR Code 對準框線內'
const INVALID_SCAN_HINT = '這不是 TripMate 的邀請 QR Code'

type JsQrResult = { data: string } | null
type JsQr = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options?: { inversionAttempts?: 'dontInvert' },
) => JsQrResult

type BarcodeDetectorResult = { rawValue?: string }
type BarcodeDetectorLike = {
  detect(source: HTMLVideoElement): Promise<BarcodeDetectorResult[]>
}
type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike

let jsQrPromise: Promise<JsQr> | null = null

function loadJsQr(): Promise<JsQr> {
  jsQrPromise ??= import('jsqr')
    .then(mod => mod.default as JsQr)
    .catch(err => {
      jsQrPromise = null
      throw err
    })
  return jsQrPromise
}

function createQrDetector(): BarcodeDetectorLike | null {
  const detectorCtor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
  if (!detectorCtor) return null
  try {
    return new detectorCtor({ formats: ['qr_code'] })
  } catch {
    return null
  }
}

async function scanWithJsQr(video: HTMLVideoElement, canvas: HTMLCanvasElement): Promise<string | null> {
  const sourceWidth = video.videoWidth
  const sourceHeight = video.videoHeight
  if (sourceWidth === 0 || sourceHeight === 0) return null

  const scale = Math.min(1, MAX_SCAN_EDGE / Math.max(sourceWidth, sourceHeight))
  canvas.width = Math.max(1, Math.round(sourceWidth * scale))
  canvas.height = Math.max(1, Math.round(sourceHeight * scale))

  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('canvas-unavailable')

  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const jsQR = await loadJsQr()
  return jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' })?.data ?? null
}

function cameraErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : undefined
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return '未允許使用相機'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return '找不到相機'
    case 'NotReadableError':
    case 'TrackStartError':
      return '無法啟動相機，請確認是否正被其他 App 使用'
    case 'OverconstrainedError':
      return '無法使用後置相機'
    case 'AbortError':
      return '相機啟動已中斷'
    default:
      return '無法啟動相機'
  }
}

interface Props {
  isOpen:  boolean
  onClose: () => void
}

export default function InviteQrScannerModal({ isOpen, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const timeoutRef = useRef<number | null>(null)
  const detectorRef = useRef<BarcodeDetectorLike | null>(null)
  const nativeErrorCountRef = useRef(0)
  const sessionRef = useRef(0)

  const [target, setTarget] = useState<ParsedInviteUrl | null>(null)
  const [restartKey, setRestartKey] = useState(0)
  const [redeeming, setRedeeming] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [scanHint, setScanHint] = useState(DEFAULT_SCAN_HINT)

  useEffect(() => {
    if (!isOpen || target) return

    let cancelled = false

    function stopCamera() {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
      streamRef.current?.getTracks().forEach(track => track.stop())
      streamRef.current = null
      detectorRef.current = null
      nativeErrorCountRef.current = 0
    }

    function queueScan() {
      timeoutRef.current = window.setTimeout(() => { void scan() }, SCAN_INTERVAL_MS)
    }

    function failCamera(message: string) {
      stopCamera()
      if (!cancelled) setCameraError(message)
    }

    function handleScanValues(values: string[]): boolean {
      let sawValue = false
      for (const value of values) {
        if (!value) continue
        sawValue = true
        const parsed = parseInviteUrl(value)
        if (parsed) {
          setTarget(parsed)
          stopCamera()
          return true
        }
      }
      setScanHint(sawValue ? INVALID_SCAN_HINT : DEFAULT_SCAN_HINT)
      return false
    }

    async function scan() {
      if (cancelled) return
      const video = videoRef.current
      const canvas = canvasRef.current
      if (!video || !canvas || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        queueScan()
        return
      }

      if (detectorRef.current) {
        try {
          const barcodes = await detectorRef.current.detect(video)
          if (cancelled) return
          nativeErrorCountRef.current = 0
          if (handleScanValues(barcodes.flatMap(code => code.rawValue ? [code.rawValue] : []))) return
          queueScan()
          return
        } catch {
          if (cancelled) return
          nativeErrorCountRef.current += 1
          if (nativeErrorCountRef.current < NATIVE_DETECT_ERROR_LIMIT) {
            queueScan()
            return
          }
          detectorRef.current = null
        }
      }

      try {
        const fallbackValue = await scanWithJsQr(video, canvas)
        if (cancelled) return
        if (handleScanValues(fallbackValue ? [fallbackValue] : [])) return
      } catch {
        failCamera('無法開始讀取 QR Code。請確認網路後再試一次')
        return
      }

      queueScan()
    }

    async function startCamera() {
      if (!window.isSecureContext) {
        setCameraError('只能在 HTTPS 環境使用相機')
        return
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError('此裝置無法使用相機')
        return
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        })
        if (cancelled) {
          stream.getTracks().forEach(track => track.stop())
          return
        }
        detectorRef.current = createQrDetector()
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
        }
        setCameraError(null)
        setScanHint(DEFAULT_SCAN_HINT)
        queueScan()
      } catch (err) {
        stopCamera()
        if (!cancelled) setCameraError(cameraErrorMessage(err))
      }
    }

    void startCamera()
    return () => {
      cancelled = true
      stopCamera()
    }
  }, [isOpen, target, restartKey])

  function resetScanner() {
    sessionRef.current += 1
    setTarget(null)
    setRedeeming(false)
    setCameraError(null)
    setScanHint(DEFAULT_SCAN_HINT)
    setRestartKey(key => key + 1)
  }

  function close() {
    resetScanner()
    onClose()
  }

  function closeForSession(session: number) {
    if (session === sessionRef.current) close()
  }

  function isCurrentSession(session: number): boolean {
    return session === sessionRef.current
  }

  const targetSession = sessionRef.current

  return (
    <BottomSheet isOpen={isOpen} onClose={close} title="掃描 QR Code 加入">
      {target ? (
        <div className="flex flex-col gap-3">
          <InviteRedeemPanel
            tripId={target.tripId}
            token={target.token}
            onDone={() => closeForSession(targetSession)}
            onCancel={close}
            isCurrent={() => isCurrentSession(targetSession)}
            onAcceptingChange={setRedeeming}
          />
          <button
            type="button"
            onClick={resetScanner}
            disabled={redeeming}
            className="h-10 rounded-xl border border-border bg-surface text-muted text-[12.5px] font-semibold inline-flex items-center justify-center gap-1.5 cursor-pointer hover:bg-app transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RotateCcw size={13} strokeWidth={2.3} />
            掃描其他 QR Code
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="relative overflow-hidden rounded-2xl bg-ink aspect-square border border-border">
            {cameraError ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
                <Camera size={28} strokeWidth={1.8} className="text-white/70" />
                <p className="m-0 text-[12.5px] leading-[1.7] text-white/80">
                  {cameraError}
                </p>
                <button
                  type="button"
                  onClick={resetScanner}
                  className="h-9 px-4 rounded-xl border border-white/25 bg-white/10 text-white text-[12px] font-semibold cursor-pointer hover:bg-white/15 transition-colors"
                >
                  再試一次
                </button>
              </div>
            ) : (
              <>
                <video
                  ref={videoRef}
                  muted
                  playsInline
                  className="absolute inset-0 h-full w-full object-cover"
                />
                <div className="absolute inset-[16%] rounded-[18px] border-2 border-white/85 shadow-[0_0_0_999px_rgba(0,0,0,0.32)]" />
              </>
            )}
          </div>

          <div className="flex items-center gap-2 rounded-xl border border-border bg-app px-3 py-2.5">
            <QrCode size={16} strokeWidth={2.2} className="text-pick shrink-0" />
            <p className="m-0 text-[12px] leading-[1.6] text-muted" role="status" aria-live="polite">
              {scanHint}
            </p>
          </div>

          <canvas ref={canvasRef} className="hidden" />
        </div>
      )}
    </BottomSheet>
  )
}
