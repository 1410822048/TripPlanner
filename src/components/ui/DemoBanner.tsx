// src/components/ui/DemoBanner.tsx
// Top-of-page banner shown in demo (signed-out preview) mode. The
// `reason` slot completes "サインインで…" — pass the suffix only,
// e.g. "予約を保存" / "費用を保存" / "投票を保存".
interface Props {
  reason:   string
  onSignIn: () => void
}

export default function DemoBanner({ reason, onSignIn }: Props) {
  return (
    <div className="mx-4 mt-3 mb-1 px-3 py-2 rounded-xl bg-accent-pale border border-accent/15 flex items-center gap-2">
      <div className="flex-1 min-w-0 text-[10.5px] text-accent leading-[1.5] tracking-[0.02em]">
        <span className="font-bold">プレビューモード</span>
        <span className="opacity-75"> · サインインで{reason}</span>
      </div>
      <button
        onClick={onSignIn}
        className="shrink-0 h-7 px-3 rounded-full bg-accent text-white text-[10.5px] font-bold tracking-[0.04em] border-none cursor-pointer transition-all hover:brightness-110 active:scale-[0.97]"
        style={{ boxShadow: '0 2px 6px rgba(61,139,122,0.25)' }}
      >
        サインイン
      </button>
    </div>
  )
}
