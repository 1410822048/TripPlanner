// src/features/trips/invites/InviteModal.tsx
// Owner-facing invite management. Flow:
//   1. Pick a role (editor / viewer) and tap Generate.
//   2. A single "current invite" card surfaces with a QR code (for direct
//      phone-to-phone scan), the full URL (truncated for display), a Copy
//      button that writes the URL to clipboard, and a Revoke button that
//      deletes the invite doc.
//   3. Regenerating replaces the previous invite atomically (see
//      inviteService.createInvite), so the card always reflects the single
//      currently-active token.
// Only trip owners pass the Firestore rules; non-owners see a loading
// placeholder because rules would deny the list read.
import { useState } from 'react'
import { Copy, Trash2, Link as LinkIcon } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import BottomSheet from '@/components/ui/BottomSheet'
import LoadingText from '@/components/ui/LoadingText'
import { useAuth } from '@/hooks/useAuth'
import { useInvites, useCreateInvite, useRevokeInvite } from './useInvites'
import { formatInviteExpiry } from './inviteService'
import { toast } from '@/shared/toast'
import type { Invite, Trip } from '@/types'

interface Props {
  isOpen:  boolean
  onClose: () => void
  trip:    Trip
}

type Role = 'editor' | 'viewer'

function buildInviteUrl(tripId: string, token: string): string {
  // Token in URL fragment — never included in HTTP request line, so it
  // doesn't leak via server logs or Referer headers when the link is
  // forwarded through third-party apps. InvitePage reads it via
  // `useLocation().hash`.
  return `${window.location.origin}/invite/${tripId}#${token}`
}


export default function InviteModal({ isOpen, onClose, trip }: Props) {
  const { state }  = useAuth(isOpen)
  const invitesQ   = useInvites(trip.id, isOpen && state.status === 'signed-in')
  const createMut  = useCreateInvite()
  const revokeMut  = useRevokeInvite(trip.id)

  const [role, setRole] = useState<Role>('editor')

  // Single `now` snapshot per modal render so expiry labels are stable and
  // don't trip the react-hooks/purity lint.
  const [now] = useState(() => Date.now())

  // With "one active invite at a time" semantics (createInvite purges old
  // invites atomically), there should be at most one non-expired entry.
  // Take the first to display; any extras (edge case if older data exists)
  // are ignored.
  const currentInvite: Invite | undefined = (invitesQ.data ?? [])
    .find(i => i.expiresAt.toMillis() > now)

  async function handleGenerate() {
    if (state.status !== 'signed-in') {
      toast.error('サインインが必要です')
      return
    }
    try {
      await createMut.mutateAsync({ trip, role, user: state.user })
      toast.success('邀請連結を作成しました')
    } catch { /* hook onError already surfaced the toast */ }
  }

  async function handleCopy(invite: Invite) {
    // navigator.clipboard requires a secure context (HTTPS or localhost).
    // Production is always HTTPS so this is the single correct path;
    // failures here (e.g. dev testing via LAN IP HTTP on a phone, or an
    // in-app browser blocking clipboard permissions) surface a generic
    // error rather than limping along with a deprecated execCommand
    // fallback.
    const url = buildInviteUrl(invite.tripId, invite.id)
    try {
      await navigator.clipboard.writeText(url)
      toast.success('コピーしました')
    } catch {
      toast.error('コピーできませんでした')
    }
  }

  async function handleRevoke(invite: Invite) {
    try {
      await revokeMut.mutateAsync(invite.id)
      toast.success('取り消しました')
    } catch { /* hook onError already surfaced the toast */ }
  }

  if (!isOpen) return null

  // Auth gate — non-signed-in users can't list invites; rules would deny
  // anyway, but we short-circuit with a clearer UX.
  if (state.status !== 'signed-in') {
    return (
      <BottomSheet isOpen onClose={onClose} title="メンバーを招待">
        <div className="py-6 text-center text-muted text-[13px]">
          <LoadingText />
        </div>
      </BottomSheet>
    )
  }

  return (
    <BottomSheet isOpen onClose={onClose} title="メンバーを招待">
      <div className="flex flex-col gap-4">

        {/* Intro */}
        <p className="m-0 text-[12px] text-muted leading-[1.6] tracking-[0.02em]">
          邀請連結で旅伴を招待できます。連結は <span className="font-semibold text-ink">5時間</span> 有効で、複数人で使用できます。
          <br />
          <span className="text-[11px] opacity-80">新しい連結を作成すると、古い連結は自動的に無効になります。</span>
        </p>

        {/* Role picker */}
        <div>
          <div className="text-[11px] font-bold text-muted tracking-[0.08em] uppercase mb-1.5">
            権限
          </div>
          <div
            role="tablist"
            aria-label="招待する権限"
            className="flex gap-1.5 p-1 rounded-xl bg-app border border-border"
          >
            <RoleTab label="編輯者"  sub="日程・費用を編集可能" active={role === 'editor'} onClick={() => setRole('editor')} />
            <RoleTab label="檢視者"  sub="閲覧のみ"             active={role === 'viewer'} onClick={() => setRole('viewer')} />
          </div>
        </div>

        {/* Generate / regenerate button — label shifts based on whether an
            invite already exists, making the replace semantic explicit. */}
        <button
          onClick={handleGenerate}
          disabled={createMut.isPending}
          className="w-full h-11 rounded-xl bg-accent text-white text-[13.5px] font-bold tracking-[0.04em] border-none cursor-pointer transition-all hover:brightness-110 active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          style={{ boxShadow: '0 2px 8px rgba(61,139,122,0.25)' }}
        >
          <LinkIcon size={14} strokeWidth={2.5} />
          {createMut.isPending
            ? '作成中…'
            : currentInvite ? '邀請連結を再作成' : '邀請連結を作成'}
        </button>

        {/* Current invite card (QR + URL + actions) or empty state. */}
        {invitesQ.isLoading ? (
          <div className="h-24 flex items-center justify-center text-muted text-[12px]">
            <LoadingText />
          </div>
        ) : currentInvite ? (
          <InviteCard
            invite={currentInvite}
            now={now}
            url={buildInviteUrl(currentInvite.tripId, currentInvite.id)}
            revoking={revokeMut.isPending}
            onCopy={() => handleCopy(currentInvite)}
            onRevoke={() => handleRevoke(currentInvite)}
          />
        ) : (
          <div className="py-6 text-center text-muted text-[12px] bg-app rounded-xl border border-dashed border-border">
            まだ邀請連結がありません
          </div>
        )}
      </div>
    </BottomSheet>
  )
}

/**
 * The "current invite" card: role + expiry header, a QR code panel for
 * phone-to-phone scanning, the full URL (truncated for fit), and the two
 * action buttons (copy / revoke). The QR renders the SAME URL the Copy
 * button writes to clipboard — scanning and pasting lead to identical flow.
 */
function InviteCard({ invite, now, url, revoking, onCopy, onRevoke }: {
  invite:   Invite
  now:      number
  url:      string
  revoking: boolean
  onCopy:   () => void
  onRevoke: () => void
}) {
  return (
    <div className="bg-surface border border-border rounded-2xl p-4 flex flex-col gap-3 shadow-[0_2px_12px_rgba(0,0,0,0.05)]">
      {/* Header: role chip + expiry countdown */}
      <div className="flex items-center justify-between">
        <RoleChip role={invite.role} />
        <div className="text-[10.5px] text-muted font-semibold tracking-[0.04em]">
          {formatInviteExpiry(invite.expiresAt, now)}
        </div>
      </div>

      {/* QR code panel — white bg ensures contrast regardless of theme.
          QRCodeSVG renders inline SVG (crisp at any DPR, no <img> loading).
          level="M" (~15% error correction) tolerates moderate smudging /
          rotation on physical screens without inflating module density. */}
      <div className="flex justify-center py-2">
        <div className="p-3 rounded-xl bg-white border border-border">
          <QRCodeSVG
            value={url}
            size={168}
            bgColor="transparent"
            fgColor="#1c1612"
            level="M"
            aria-label="邀請連結の QR コード"
          />
        </div>
      </div>

      {/* URL display — monospace-ish read, truncated so long tokens don't
          break the card width; the Copy button ships the full URL. */}
      <div className="px-3 py-2 bg-app border border-border rounded-lg">
        <div className="text-[10.5px] text-muted truncate" title={url}>
          {url}
        </div>
      </div>

      {/* Action row */}
      <div className="flex gap-2">
        <button
          onClick={onCopy}
          className="flex-1 h-10 rounded-lg border border-border bg-surface text-ink text-[12.5px] font-semibold flex items-center justify-center gap-1.5 cursor-pointer hover:bg-accent-pale hover:border-accent hover:text-accent transition-colors"
        >
          <Copy size={13} strokeWidth={2} />
          連結をコピー
        </button>
        <button
          onClick={onRevoke}
          disabled={revoking}
          className="h-10 w-10 rounded-lg border border-border bg-surface text-muted flex items-center justify-center cursor-pointer hover:bg-danger-pale hover:text-[#A04040] hover:border-[#E9C5C5] transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          aria-label="取り消す"
        >
          <Trash2 size={13} strokeWidth={2} />
        </button>
      </div>
    </div>
  )
}

function RoleTab({ label, sub, active, onClick }: {
  label: string; sub: string; active: boolean; onClick: () => void
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={[
        'flex-1 py-2 px-2.5 rounded-lg border-none cursor-pointer transition-all text-left',
        active ? 'bg-surface shadow-[0_1px_4px_rgba(0,0,0,0.08)]' : 'bg-transparent hover:bg-surface/50',
      ].join(' ')}
    >
      <div className={[
        'text-[12.5px] font-bold leading-tight',
        active ? 'text-ink' : 'text-muted',
      ].join(' ')}>
        {label}
      </div>
      <div className={[
        'text-[10px] mt-0.5',
        active ? 'text-muted' : 'text-muted opacity-70',
      ].join(' ')}>
        {sub}
      </div>
    </button>
  )
}

function RoleChip({ role }: { role: Role }) {
  const isEditor = role === 'editor'
  return (
    <div
      className={[
        'shrink-0 px-2 py-1 rounded-md text-[10px] font-bold tracking-[0.04em]',
        isEditor
          ? 'bg-accent-pale text-accent border border-accent/20'
          : 'bg-app text-muted border border-border',
      ].join(' ')}
    >
      {isEditor ? '編輯' : '閲覧'}
    </div>
  )
}
