// src/features/schedule/components/CreateTripModal.tsx
import { useRef, useState } from 'react'
import { MapPin } from 'lucide-react'
import BottomSheet from '@/components/ui/BottomSheet'
import GoogleIcon from '@/components/icons/GoogleIcon'
import { DatePicker, type DatePickerHandle } from '@/components/ui/pickers'
import FormField from '@/components/ui/FormField'
import { inputClass } from '@/components/ui/inputStyle'
import LoadingText from '@/components/ui/LoadingText'
import SaveButton from '@/components/ui/SaveButton'
import { useAuth } from '@/hooks/useAuth'
import { useCreateTrip } from '../hooks/useTrips'
import { useTripStore } from '@/store/tripStore'
import { CreateTripSchema } from '@/types'
import { toast } from '@/shared/toast'

interface Props {
  isOpen:  boolean
  onClose: () => void
}

export default function CreateTripModal({ isOpen, onClose }: Props) {
  // Lazy auth: SDK only loads when the modal opens — preview-mode users who
  // never tap "create trip" pay nothing.
  const { state, signInWithGoogle } = useAuth(isOpen)
  const createMut      = useCreateTrip()
  const setCurrentTrip = useTripStore(s => s.setCurrentTrip)
  const addRecentTrip  = useTripStore(s => s.addRecentTrip)

  const [title,       setTitle]       = useState('')
  const [destination, setDestination] = useState('')
  const [startDate,   setStartDate]   = useState('')
  const [endDate,     setEndDate]     = useState('')
  const [errors,      setErrors]      = useState<Record<string, string>>({})
  const [signingIn,   setSigningIn]   = useState(false)

  const endDateRef = useRef<DatePickerHandle>(null)

  function resetForm() {
    setTitle(''); setDestination(''); setStartDate(''); setEndDate(''); setErrors({})
  }

  function close() { onClose(); resetForm() }

  function validate() {
    const parsed = CreateTripSchema.safeParse({
      title, destination, startDate, endDate, currency: 'TWD',
    })
    if (!parsed.success) {
      const errs: Record<string, string> = {}
      for (const iss of parsed.error.issues) {
        const key = String(iss.path[0] ?? 'form')
        if (!errs[key]) errs[key] = iss.message
      }
      setErrors(errs)
      return null
    }
    if (endDate < startDate) {
      setErrors({ endDate: '結束日期不可早於開始日期' })
      return null
    }
    setErrors({})
    return parsed.data
  }

  async function handleSave() {
    const data = validate()
    if (!data) return
    if (state.status !== 'signed-in') return
    try {
      const trip = await createMut.mutateAsync({ input: data, user: state.user })
      setCurrentTrip(trip)
      addRecentTrip(trip.id)
      toast.success(`「${trip.title}」を作成しました`)
      close()
    } catch (e) {
      toast.error(e instanceof Error ? `作成に失敗：${e.message}` : '作成に失敗しました')
    }
  }

  async function handleSignIn() {
    setSigningIn(true)
    try { await signInWithGoogle() }
    catch (e) {
      const code = (e as { code?: string })?.code
      if (code !== 'auth/popup-closed-by-user') {
        toast.error(e instanceof Error ? e.message : 'サインインに失敗しました')
      }
    } finally { setSigningIn(false) }
  }

  if (!isOpen) return null

  // Auth gate: must sign-in before we can write `ownerId == uid()` and the
  // self-bootstrap member doc required by Firestore rules.
  if (state.status === 'loading') {
    return (
      <BottomSheet isOpen onClose={close} title="新しい旅程">
        <div className="h-32 flex items-center justify-center text-muted text-[13px]">
          <LoadingText />
        </div>
      </BottomSheet>
    )
  }
  if (state.status !== 'signed-in') {
    return (
      <BottomSheet isOpen onClose={close} title="サインインが必要です">
        <div className="py-4 text-center">
          <div className="text-[44px] leading-none mb-3">☁️</div>
          <p className="m-0 mb-5 text-[13px] text-ink leading-[1.7] tracking-[0.02em]">
            自分の旅程を作成するには、<br />
            Google アカウントでサインインしてください。
          </p>
          <button
            onClick={handleSignIn}
            disabled={signingIn}
            className="w-full max-w-[280px] h-12 rounded-chip border border-border bg-surface text-ink text-[14px] font-semibold inline-flex items-center justify-center gap-2.5 cursor-pointer transition-all hover:-translate-y-px disabled:opacity-60 disabled:cursor-not-allowed"
            style={{ boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}
          >
            <GoogleIcon size={18} />
            {signingIn ? 'サインイン中…' : 'Google でサインイン'}
          </button>
          <p className="mt-5 text-[10.5px] text-muted leading-[1.6] tracking-[0.02em] max-w-[280px] mx-auto">
            サインイン後、プレビュー中のデモデータは<br />
            あなた自身の旅程に置き換わります。
          </p>
        </div>
      </BottomSheet>
    )
  }

  return (
    <BottomSheet
      isOpen
      onClose={close}
      title="新しい旅程"
      footer={<SaveButton onClick={handleSave} isSaving={createMut.isPending} label="作成" />}
    >
      <FormField label="旅程名稱" error={errors.title} required>
        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="例：東京五日間"
          className={inputClass(!!errors.title)}
        />
      </FormField>

      <FormField label="目的地" error={errors.destination} required>
        <div className="relative">
          <MapPin size={14} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none text-muted" />
          <input
            value={destination}
            onChange={e => setDestination(e.target.value)}
            placeholder="例：東京 · 淺草 · 新宿"
            className={`${inputClass(!!errors.destination)} pl-[34px]`}
          />
        </div>
      </FormField>

      <div className="flex gap-2.5">
        <FormField label="開始日" error={errors.startDate} required className="flex-1">
          <DatePicker
            value={startDate}
            onChange={v => {
              setStartDate(v)
              if (v) setTimeout(() => endDateRef.current?.open({ viewDate: v }), 160)
            }}
            error={!!errors.startDate}
          />
        </FormField>
        <FormField label="結束日" error={errors.endDate} required className="flex-1">
          <DatePicker ref={endDateRef} value={endDate} onChange={setEndDate} error={!!errors.endDate} />
        </FormField>
      </div>
    </BottomSheet>
  )
}

