// src/components/ui/LoadingText.tsx
// Spinner + label pair. Inherits font/color from its container so existing
// callers keep their own padding / alignment / text color.
import { Loader } from 'lucide-react'

interface Props {
  label?: string
}

export default function LoadingText({ label = '読み込み中…' }: Props) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Loader size={13} strokeWidth={2} className="animate-spin" />
      <span>{label}</span>
    </span>
  )
}
