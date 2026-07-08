// src/features/trips/invites/InvitePage.tsx
// Standalone deep-link entry for /invite/:tripId#<token>. The redeem UI
// itself lives in InviteRedeemPanel so the PWA-internal QR scanner can reuse
// the same confirmation + acceptInvite flow without navigating outside the app.
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import InviteRedeemPanel from './InviteRedeemPanel'

export default function InvitePage() {
  const { tripId } = useParams<{ tripId: string }>()
  const location = useLocation()
  const navigate = useNavigate()

  const token = (location.hash.startsWith('#') ? location.hash.slice(1) : location.hash) || undefined
  const done = () => navigate('/schedule', { replace: true })

  return (
    <div className="fixed inset-0 max-w-[430px] mx-auto bg-app flex flex-col">
      <div className="flex-1 overflow-y-auto px-5 py-10 flex flex-col justify-center">
        <div className="text-center mb-6">
          <div className="text-[10.5px] font-bold text-muted tracking-[0.14em] uppercase mb-1">
            Trip Invitation
          </div>
          <h1 className="m-0 text-[22px] font-black text-teal -tracking-[0.3px]">
            旅への招待
          </h1>
        </div>

        <InviteRedeemPanel
          tripId={tripId}
          token={token}
          onDone={done}
          onCancel={done}
        />
      </div>
    </div>
  )
}
