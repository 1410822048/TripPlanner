// src/features/trips/components/CreateTripModal.tsx
// Rendered per open by the host (keyed by an open generation), so every
// open is a fresh instance: no resetForm, and the write is owned by the
// instance (useAwaitedSave). A create that settles after the sheet was
// dismissed — or reopened as a new instance — reports its result (cache
// seed via onSuccess + toast) but never switches the selected trip or
// closes whatever the user has open now.
//
// Not an offline hand-off candidate: the trip create batch waits for the
// server and must not be queued for a second attempt. Offline, the draft
// stays and the sheet asks for a connection.
import { useRef, useState } from 'react'
import { MapPin } from 'lucide-react'
import BottomSheet from '@/components/ui/BottomSheet'
import FormModalShell from '@/components/ui/FormModalShell'
import GoogleIcon from '@/components/icons/GoogleIcon'
import { DatePicker, type DatePickerHandle } from '@/components/ui/pickers'
import FormField from '@/components/ui/FormField'
import { inputClass } from '@/components/ui/inputStyle'
import LoadingText from '@/components/ui/LoadingText'
import CurrencyPicker from '@/components/ui/CurrencyPicker'
import CountryPicker from '@/components/ui/CountryPicker'
import { DEFAULT_CURRENCY } from '@/utils/currency'
import { currencyCountrySuggestion } from '@/utils/country'
import { useAuth } from '@/hooks/useAuth'
import { useAwaitedSave } from '@/hooks/useAwaitedSave'
import { useCreateTrip } from '@/features/trips/hooks/useTrips'
import { useTripStore } from '@/store/tripStore'
import { CreateTripSchema } from '@/types/trip'
import { toast } from '@/shared/toast'
import { countryAfterCurrencyChange } from '@/features/trips/countryContext'
import { userErrorMessage } from '@/utils/errorMessage'
import { getClientWriteBlockReason } from '@/services/clientCompatibility'
import { isOffline, OFFLINE_NEEDS_CONNECTION_MESSAGE } from '@/utils/offlineHandOff'

interface Props {
  isOpen:  boolean
  onClose: () => void
}

export default function CreateTripModal({ isOpen, onClose }: Props) {
  // Lazy auth: SDK only loads when the modal opens — preview-mode users who
  // never tap "create trip" pay nothing.
  const { state, signInWithGoogle } = useAuth(isOpen)
  const createMut         = useCreateTrip()
  const setSelectedTripId = useTripStore(s => s.setSelectedTripId)
  const awaited           = useAwaitedSave(onClose)

  const [title,       setTitle]       = useState('')
  const [destination, setDestination] = useState('')
  const [startDate,   setStartDate]   = useState('')
  const [endDate,     setEndDate]     = useState('')
  const [currency,    setCurrency]    = useState(DEFAULT_CURRENCY)
  const [defaultCountryCode, setDefaultCountryCode] = useState(
    () => currencyCountrySuggestion(DEFAULT_CURRENCY) ?? '',
  )
  const [countryWasSelected, setCountryWasSelected] = useState(false)
  const [errors,      setErrors]      = useState<Record<string, string>>({})
  const [signingIn,   setSigningIn]   = useState(false)
  // Synchronous refusals (offline / obsolete bundle): the draft stays and
  // the reason sits in the banner until the next attempt.
  const [refusal,     setRefusal]     = useState<string | null>(null)

  const endDateRef = useRef<DatePickerHandle>(null)

  function validate() {
    const parsed = CreateTripSchema.safeParse({
      title, destination, startDate, endDate, currency, defaultCountryCode,
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
    setErrors({})
    return parsed.data
  }

  function handleSave() {
    const data = validate()
    if (!data) return
    if (state.status !== 'signed-in') return
    const user = state.user
    awaited.submit(() => {
      setRefusal(null)
      if (isOffline()) { setRefusal(OFFLINE_NEEDS_CONNECTION_MESSAGE); return }
      // The global guard would also throw UpdateRequiredError, but silently
      // (no toast) — say it here, in the sheet.
      const writeBlockReason = getClientWriteBlockReason()
      if (writeBlockReason) { setRefusal(writeBlockReason); return }
      // Failure: the global MutationCache.onError toasts with the CREATE_TRIP
      // label and the draft stays (useAwaitedSave closes only on success).
      return createMut.mutateAsync({ input: data, user }).then(trip => {
        toast.success(`已建立「${trip.title}」`)
        // Late result (sheet dismissed, or reopened as a new instance): the
        // trip is already in the list via onSuccess; do not switch to it or
        // touch the sheet the user has open now.
        if (!awaited.stillOpen()) return
        setSelectedTripId(trip.id)
      })
    })
  }

  async function handleSignIn() {
    setSigningIn(true)
    try { await signInWithGoogle() }
    catch (e) {
      const code = (e as { code?: string })?.code
      if (code !== 'auth/popup-closed-by-user') {
        toast.error(userErrorMessage(e, '登入失敗'))
      }
    } finally { setSigningIn(false) }
  }

  if (!isOpen) return null

  // Auth gate: must sign-in before we can write `ownerId == uid()` and the
  // self-bootstrap member doc required by Firestore rules.
  if (state.status === 'loading') {
    return (
      <BottomSheet isOpen onClose={onClose} title="新旅程">
        <div className="h-32 flex items-center justify-center text-muted text-[13px]">
          <LoadingText />
        </div>
      </BottomSheet>
    )
  }
  if (state.status !== 'signed-in') {
    return (
      <BottomSheet isOpen onClose={onClose} title="需要登入">
        <div className="py-4 text-center">
          <div className="text-[44px] leading-none mb-3">☁️</div>
          <p className="m-0 mb-5 text-[13px] text-ink leading-[1.7] tracking-[0.02em]">
            若要建立自己的旅程，<br />
            請使用 Google 帳戶登入。
          </p>
          <button
            onClick={handleSignIn}
            disabled={signingIn}
            className="w-full max-w-[280px] h-12 rounded-chip border border-border bg-surface text-ink text-[14px] font-semibold inline-flex items-center justify-center gap-2.5 cursor-pointer transition-all hover:-translate-y-px disabled:opacity-60 disabled:cursor-not-allowed"
            style={{ boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}
          >
            <GoogleIcon size={18} />
            {signingIn ? '登入中…' : '使用 Google 登入'}
          </button>
          <p className="mt-5 text-[10.5px] text-muted leading-[1.6] tracking-[0.02em] max-w-[280px] mx-auto">
            登入後，預覽中的示範資料會<br />
            改為你自己的旅程。
          </p>
        </div>
      </BottomSheet>
    )
  }

  return (
    <FormModalShell
      isOpen
      isSaving={awaited.saving}
      title="新旅程"
      saveLabel="建立旅程"
      saveError={refusal ?? awaited.error}
      onClose={onClose}
      onSave={handleSave}
    >
      <FormField label="旅程名稱" error={errors.title} required>
        <input
          value={title}
          maxLength={50}
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
            maxLength={200}
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

      <FormField label="幣別">
        <CurrencyPicker
          value={currency}
          onChange={nextCurrency => {
            setCurrency(nextCurrency)
            setDefaultCountryCode(current => countryAfterCurrencyChange(
              current,
              nextCurrency,
              countryWasSelected,
            ))
          }}
        />
      </FormField>

      <FormField label="旅程國家" error={errors.defaultCountryCode} required>
        <CountryPicker
          value={defaultCountryCode}
          onChange={countryCode => {
            setDefaultCountryCode(countryCode)
            setCountryWasSelected(true)
          }}
          error={!!errors.defaultCountryCode}
        />
      </FormField>
    </FormModalShell>
  )
}
