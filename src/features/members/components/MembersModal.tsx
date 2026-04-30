// src/features/members/components/MembersModal.tsx
// Owner-facing member management. Lists every member of the trip with their
// role badge; the owner can remove any non-owner member. Viewer / editor see
// the list read-only (the remove affordance is gated client-side on ownership
// AND rule-side via isTripOwner, so a non-owner tampering with the DOM still
// gets a permission-denied).
//
// Intentionally does NOT show invite-link UI — the "share" action opens
// InviteModal for that. This sheet is scoped to post-join membership admin.
import { useState } from 'react'
import BottomSheet from '@/components/ui/BottomSheet'
import ConfirmSheet from '@/components/ui/ConfirmSheet'
import LoadingText from '@/components/ui/LoadingText'
import { Trash2, ArrowLeftRight } from 'lucide-react'
import { useMembers, useRemoveMember, useUpdateMemberRole } from '@/features/members/hooks/useMembers'
import { memberToTripMember } from '@/features/members/utils'
import { useUid } from '@/hooks/useAuth'
import { toast } from '@/shared/toast'
import type { Member, Trip } from '@/types'

interface Props {
  isOpen:  boolean
  onClose: () => void
  trip:    Trip
}

export default function MembersModal({ isOpen, onClose, trip }: Props) {
  const uid           = useUid(isOpen)
  const membersQ      = useMembers(isOpen ? trip.id : undefined)
  const removeMut     = useRemoveMember(trip.id)
  const updateRoleMut = useUpdateMemberRole(trip.id)

  // Pending remove target — drives the ConfirmSheet. Null means no dialog.
  const [pendingRemove, setPendingRemove] = useState<Member | null>(null)

  const isOwner = uid === trip.ownerId

  async function handleConfirmRemove() {
    if (!pendingRemove) return
    const target = pendingRemove
    try {
      await removeMut.mutateAsync(target.id)
      toast.success(`${target.displayName} を削除しました`)
      setPendingRemove(null)
    } catch { /* hook onError already surfaced the toast */ }
  }

  async function handleToggleRole(m: Member) {
    if (m.role === 'owner') return
    const next = m.role === 'editor' ? 'viewer' : 'editor'
    try {
      await updateRoleMut.mutateAsync({ memberId: m.id, role: next })
      toast.success(`${m.displayName} を ${next === 'editor' ? '編輯者' : '檢視者'} に変更しました`)
    } catch { /* hook onError already surfaced the toast */ }
  }

  if (!isOpen) return null

  return (
    <BottomSheet isOpen onClose={onClose} title="メンバー管理">
      <div className="flex flex-col gap-3">
        <p className="m-0 text-[12px] text-muted leading-[1.6] tracking-[0.02em]">
          この旅程のメンバー一覧です。
          {isOwner
            ? ' オーナーは他のメンバーを削除できます。'
            : ' メンバーの追加・削除はオーナーのみが行えます。'}
        </p>

        {membersQ.isLoading ? (
          <div className="h-24 flex items-center justify-center text-muted text-[12px]">
            <LoadingText />
          </div>
        ) : membersQ.isError ? (
          <div className="py-6 text-center text-[12px] text-[#A04040] bg-danger-pale rounded-xl border border-[#E9C5C5]">
            読み込みに失敗しました
          </div>
        ) : (
          <ul className="flex flex-col gap-2 list-none m-0 p-0">
            {(membersQ.data ?? []).map(m => {
              const chip = memberToTripMember(m)
              const isSelf = m.userId === uid
              const canEditRole = isOwner && m.role !== 'owner' && !isSelf
              const canRemove   = canEditRole
              return (
                <li
                  key={m.id}
                  className="flex items-center gap-2.5 p-2.5 bg-surface border border-border rounded-xl"
                >
                  <div
                    className="w-10 h-10 rounded-full shrink-0 flex items-center justify-center text-[13px] font-bold shadow-[0_1px_4px_rgba(0,0,0,0.08)]"
                    style={{ background: chip.bg, color: chip.color }}
                    aria-hidden
                  >
                    {chip.label}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-semibold text-ink truncate">
                      {m.displayName}
                      {isSelf && <span className="ml-1.5 text-[10.5px] text-muted font-normal">(あなた)</span>}
                    </div>
                    <div className="text-[10.5px] text-muted mt-0.5">
                      {roleLabel(m.role)}
                    </div>
                  </div>
                  <RoleChip
                    role={m.role}
                    editable={canEditRole}
                    disabled={updateRoleMut.isPending}
                    onClick={() => handleToggleRole(m)}
                  />
                  {canRemove && (
                    <button
                      onClick={() => setPendingRemove(m)}
                      disabled={removeMut.isPending}
                      aria-label="メンバーを削除"
                      className="w-8 h-8 rounded-lg border border-border bg-app text-muted hover:bg-danger-pale hover:text-[#A04040] hover:border-[#E9C5C5] flex items-center justify-center cursor-pointer transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Trash2 size={13} strokeWidth={2} />
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <ConfirmSheet
        isOpen={pendingRemove !== null}
        title="メンバーを削除しますか？"
        description={pendingRemove && (
          <>
            <span className="font-bold text-ink">{pendingRemove.displayName}</span> を旅程から削除します。<br />
            再度招待しない限り、この旅程へはアクセスできなくなります。
          </>
        )}
        icon={
          <div className="w-14 h-14 rounded-2xl bg-danger-pale flex items-center justify-center">
            <Trash2 size={22} strokeWidth={2} className="text-[#A04040]" />
          </div>
        }
        confirmLabel={removeMut.isPending ? '削除中…' : '削除'}
        tone="danger"
        loading={removeMut.isPending}
        onClose={() => setPendingRemove(null)}
        onConfirm={handleConfirmRemove}
      />
    </BottomSheet>
  )
}

function roleLabel(role: Member['role']): string {
  switch (role) {
    case 'owner':  return 'オーナー · 全権管理'
    case 'editor': return '編輯者 · 編集可能'
    case 'viewer': return '檢視者 · 閲覧のみ'
  }
}

/**
 * Role indicator. Becomes a button that cycles editor ↔ viewer when the
 * caller flags it editable (owner context + non-owner target). Owner rows
 * are always a plain chip (ownership transfer is not in scope; invariant is
 * exactly one owner per trip).
 */
function RoleChip({
  role, editable, disabled, onClick,
}: {
  role: Member['role']
  editable: boolean
  disabled: boolean
  onClick: () => void
}) {
  const isOwner  = role === 'owner'
  const isEditor = role === 'editor'
  const label    = isOwner ? 'OWNER' : isEditor ? '編輯' : '閲覧'
  const palette  = isOwner
    ? 'bg-teal-pale text-teal border-teal/20'
    : isEditor
      ? 'bg-accent-pale text-accent border-accent/20'
      : 'bg-app text-muted border-border'

  if (!editable) {
    return (
      <div className={`shrink-0 px-2 py-1 rounded-md text-[10px] font-bold tracking-[0.04em] border ${palette}`}>
        {label}
      </div>
    )
  }
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={`権限を切り替える（現在: ${label}）`}
      title="クリックで編輯 / 閲覧 を切り替え"
      className={[
        'shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold tracking-[0.04em] border cursor-pointer transition-all',
        'hover:brightness-95 active:scale-[0.97]',
        'disabled:opacity-60 disabled:cursor-not-allowed',
        palette,
      ].join(' ')}
    >
      {label}
      <ArrowLeftRight size={10} strokeWidth={2.5} className="opacity-70" />
    </button>
  )
}
