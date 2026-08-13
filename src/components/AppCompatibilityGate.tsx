import { RefreshCw } from 'lucide-react'
import { useClientCompatibility } from '@/hooks/useClientCompatibility'
import PwaPromptBanner from '@/components/ui/PwaPromptBanner'
import { usePwaUpdate } from '@/hooks/usePwaUpdate'

export default function AppCompatibilityGate() {
  const { updateRequired } = useClientCompatibility()
  const { needRefresh, checkingForUpdate, requestUpdate } = usePwaUpdate()

  if (!updateRequired) return null

  return (
    <PwaPromptBanner
      role="alert"
      position="top"
      ariaLabel="App 版本需要更新"
      icon={<RefreshCw size={16} strokeWidth={2} />}
      title="請更新 App 後繼續"
      description="此版本已停止寫入，更新後即可繼續儲存"
      actionLabel={needRefresh ? '立即更新' : checkingForUpdate ? '檢查中…' : '檢查更新'}
      actionDisabled={checkingForUpdate}
      onAction={requestUpdate}
    />
  )
}
