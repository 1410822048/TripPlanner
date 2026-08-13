// src/components/PwaUpdatePrompt.tsx
// Optional banner shown when a compatible new service worker is waiting.
// Registration and update checks live in root-level PwaUpdateProvider so
// standalone routes participate too; this AppLayout consumer only renders
// the bottom-nav-positioned prompt.
import { RefreshCw } from 'lucide-react'
import PwaPromptBanner from '@/components/ui/PwaPromptBanner'
import { usePwaUpdate } from '@/hooks/usePwaUpdate'
import { useClientCompatibility } from '@/hooks/useClientCompatibility'

export default function PwaUpdatePrompt() {
  const { needRefresh, dismissUpdate, activateUpdate } = usePwaUpdate()
  const { updateRequired } = useClientCompatibility()

  // The mandatory root prompt owns the CTA while this client is blocked.
  if (!needRefresh || updateRequired) return null

  return (
    <PwaPromptBanner
      role="status"
      // Sit 12px above the nav's top edge. The nav already spans the
      // viewport's bottom var(--nav-h) — including the iOS home-indicator
      // safe area on standalone PWAs — so layering an extra
      // env(safe-area-inset-bottom) here would double-count that space
      // and push the banner ~34px higher than the user expects on iPhone.
      icon={<RefreshCw size={16} strokeWidth={2} />}
      title="有新版本可用"
      description="重新載入即可更新"
      actionLabel="更新"
      onDismiss={dismissUpdate}
      onAction={activateUpdate}
    />
  )
}
