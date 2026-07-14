// src/features/schedule/components/TripsErrorState.tsx
// Shown when the cloud `useMyTrips` query throws — typically a Firestore
// permission / index issue. We deliberately surface the error message
// inline (instead of a silent infinite spinner) so the user / dev can
// see what went wrong; the retry button calls `refetch`.

interface Props {
  message: string
  onRetry: () => void
}

export default function TripsErrorState({ message, onRetry }: Props) {
  return (
    <div className="flex flex-col items-center justify-center h-full px-6 text-center gap-3">
      <div className="text-[40px] leading-none">⚠️</div>
      <div className="text-[13px] text-ink leading-[1.6]">載入失敗</div>
      <div className="text-[11px] text-muted leading-[1.6] max-w-[320px] break-words">
        {message}
      </div>
      <button
        onClick={onRetry}
        className="mt-2 h-10 px-5 rounded-chip border border-border bg-surface text-ink text-[12.5px] font-semibold cursor-pointer hover:bg-tile transition-colors"
      >
        重新載入
      </button>
    </div>
  )
}
