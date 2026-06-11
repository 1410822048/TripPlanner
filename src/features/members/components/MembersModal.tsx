// src/features/members/components/MembersModal.tsx
// Member management sheet. Lists every member with their role badge.
// Owner gets per-member actions (change role / transfer ownership / remove)
// behind a row `...` button → member action sheet; non-owner members see the
// list read-only plus a footer "leave trip" button. All affordances are
// gated client-side AND rule-side (Worker-authoritative), so DOM tampering
// still gets permission-denied.
//
// Invariant: EXACTLY ONE sheet is ever open at a time. ConfirmSheet is itself
// a BottomSheet, so the list sheet, the per-member action sheet, and each
// confirm sheet (remove / transfer / leave) are mutually-exclusive siblings —
// never stack two sheet handles / backdrops.
//
// Intentionally does NOT show invite-link UI — the "share" action opens
// InviteModal for that.
import { useState } from 'react'
import BottomSheet from '@/components/ui/BottomSheet'
import ConfirmSheet from '@/components/ui/ConfirmSheet'
import LoadingText from '@/components/ui/LoadingText'
import MemberAvatar from '@/components/ui/MemberAvatar'
import { Trash2, ArrowLeftRight, LogOut, MoreVertical, Crown } from 'lucide-react'
import { useMembers, useRemoveMember, useUpdateMemberRole, useTransferOwnership } from '@/features/members/hooks/useMembers'
import { memberToTripMember } from '@/features/members/utils'
import { useUid } from '@/hooks/useAuth'
import { toast } from '@/shared/toast'
import type { Member, Trip } from '@/types'

interface Props {
  isOpen:  boolean
  onClose: () => void
  trip:    Trip
  /** Non-owner self-leave. The parent (useSchedulePageState) owns the
   *  trip-switch + optimistic leave mutation and closes this modal; we
   *  just confirm intent and call up. */
  onLeave: () => void
}

export default function MembersModal({ isOpen, onClose, trip, onLeave }: Props) {
  const uid           = useUid(isOpen)
  const membersQ      = useMembers(isOpen ? trip.id : undefined)
  const removeMut     = useRemoveMember(trip.id)
  const updateRoleMut = useUpdateMemberRole(trip.id)
  const transferMut   = useTransferOwnership(trip.id)

  // Per-member action sheet target (owner drill-down from a row `...`).
  const [actionTarget, setActionTarget] = useState<Member | null>(null)
  // Confirm gates — each drives a ConfirmSheet.
  const [pendingRemove, setPendingRemove] = useState<Member | null>(null)
  const [pendingTransfer, setPendingTransfer] = useState<Member | null>(null)
  const [confirmLeave, setConfirmLeave] = useState(false)

  const isOwner = uid === trip.ownerId
  // Only a signed-in non-owner member can leave (owner must transfer or
  // delete). Guard on uid so a transient undefined-uid render doesn't flash
  // the affordance before ownership is known.
  const canLeave = !!uid && !isOwner

  async function handleConfirmRemove() {
    if (!pendingRemove) return
    const target = pendingRemove
    try {
      await removeMut.mutateAsync(target.id)
      toast.success(`${target.displayName} を削除しました`)
      setPendingRemove(null)  // success only → close confirm
    } catch { /* hook onError already surfaced the toast; keep sheet open */ }
  }

  async function handleConfirmTransfer() {
    if (!pendingTransfer) return
    const target = pendingTransfer
    try {
      await transferMut.mutateAsync(target.userId)
      toast.success(`${target.displayName} にオーナーを譲りました`)
      setPendingTransfer(null)  // success only → close confirm
    } catch { /* MutationCache.onError already toasted; keep confirm open to retry/cancel */ }
  }

  async function handleToggleRole(m: Member) {
    if (m.role === 'owner') return
    const next = m.role === 'editor' ? 'viewer' : 'editor'
    try {
      await updateRoleMut.mutateAsync({ memberId: m.id, role: next })
      toast.success(`${m.displayName} を ${next === 'editor' ? '編輯者' : '檢視者'} に変更しました`)
    } catch { /* hook onError already surfaced the toast */ }
  }

  // Action-sheet handlers. Drill back to the list (clear actionTarget) when
  // opening a confirm so we never render the action sheet + a confirm at once.
  function toggleRoleFromAction() {
    if (!actionTarget) return
    void handleToggleRole(actionTarget)  // optimistic patch reflects in list
    setActionTarget(null)
  }
  function openTransferFromAction() {
    if (!actionTarget) return
    setPendingTransfer(actionTarget)
    setActionTarget(null)
  }
  function openRemoveFromAction() {
    if (!actionTarget) return
    setPendingRemove(actionTarget)
    setActionTarget(null)
  }

  function handleConfirmLeave() {
    setConfirmLeave(false)
    onLeave()  // parent closes the modal + runs the optimistic leave
  }
  // This component is `if (!isOpen) return null` rather than unmounted, so
  // local state persists across open/close. Reset every gate on close so a
  // reopen never shows a stale action / confirm sheet.
  function handleClose() {
    setActionTarget(null)
    setPendingRemove(null)
    setPendingTransfer(null)
    setConfirmLeave(false)
    onClose()
  }

  if (!isOpen) return null

  const anyConfirmOpen = pendingRemove !== null || pendingTransfer !== null || confirmLeave

  return (
    <>
      {/* List sheet — only when no action sheet and no confirm is open. */}
      {!actionTarget && !anyConfirmOpen && (
        <BottomSheet isOpen onClose={handleClose} title="メンバー管理">
          <div className="flex flex-col gap-3">
            <p className="m-0 text-[12px] text-muted leading-[1.6] tracking-[0.02em]">
              この旅程のメンバー一覧です。
              {isOwner
                ? ' オーナーは各メンバーの「…」から権限変更・オーナー譲渡・削除ができます。'
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
                  // Owner can manage any non-owner member (change role /
                  // transfer / remove) via the `...` action sheet.
                  const canManage = isOwner && m.role !== 'owner' && !isSelf
                  return (
                    <li
                      key={m.id}
                      className="flex items-center gap-2.5 p-2.5 bg-surface border border-border rounded-xl"
                    >
                      <MemberAvatar
                        member={chip}
                        size={40}
                        className="text-[13px] shadow-[0_1px_4px_rgba(0,0,0,0.08)]"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-semibold text-ink truncate">
                          {m.displayName}
                          {isSelf && <span className="ml-1.5 text-[10.5px] text-muted font-normal">(あなた)</span>}
                        </div>
                        <div className="text-[10.5px] text-muted mt-0.5">
                          {roleLabel(m.role)}
                        </div>
                      </div>
                      <RoleChip role={m.role} />
                      {canManage && (
                        <button
                          onClick={() => setActionTarget(m)}
                          aria-label={`${m.displayName} の操作`}
                          className="w-8 h-8 rounded-lg border border-border bg-app text-muted hover:bg-tile hover:text-ink flex items-center justify-center cursor-pointer transition-colors shrink-0"
                        >
                          <MoreVertical size={15} strokeWidth={2} />
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}

            {/* Non-owner self-leave. Owners don't see this (single-owner
                invariant — they transfer ownership or delete the trip). */}
            {canLeave && (
              <>
                <div className="border-t border-dashed border-border" />
                <button
                  onClick={() => setConfirmLeave(true)}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl border border-[#E9C5C5] bg-danger-pale text-[#A04040] text-[12.5px] font-semibold cursor-pointer transition-colors hover:brightness-95"
                >
                  <LogOut size={14} strokeWidth={2} />
                  この旅程から退出
                </button>
              </>
            )}
          </div>
        </BottomSheet>
      )}

      {/* Per-member action sheet (owner drill-down). Mutually exclusive with
          the list + confirms. Its onClose returns to the list, not full-close. */}
      {actionTarget && !anyConfirmOpen && (
        <BottomSheet isOpen onClose={() => setActionTarget(null)} title="メンバー操作">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2.5">
              <MemberAvatar
                member={memberToTripMember(actionTarget)}
                size={40}
                className="text-[13px] shadow-[0_1px_4px_rgba(0,0,0,0.08)]"
              />
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-ink truncate">{actionTarget.displayName}</div>
                <div className="text-[10.5px] text-muted mt-0.5">{roleLabel(actionTarget.role)}</div>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <button
                type="button"
                onClick={toggleRoleFromAction}
                className="flex items-center gap-3 px-3 min-h-12 py-2 rounded-input bg-app border-none cursor-pointer text-left active:bg-border/40 transition-colors"
              >
                <ArrowLeftRight size={18} strokeWidth={2} className="text-ink shrink-0" />
                <span className="text-[14.5px] text-ink font-medium">
                  {actionTarget.role === 'editor' ? '檢視者に変更' : '編輯者に変更'}
                </span>
              </button>
              <button
                type="button"
                onClick={openTransferFromAction}
                className="flex items-center gap-3 px-3 min-h-12 py-2 rounded-input bg-app border-none cursor-pointer text-left active:bg-teal-pale transition-colors"
              >
                <Crown size={18} strokeWidth={2} className="text-teal shrink-0" />
                <span className="text-[14.5px] text-teal font-medium">オーナーを譲る</span>
              </button>
              <button
                type="button"
                onClick={openRemoveFromAction}
                className="flex items-center gap-3 px-3 min-h-12 py-2 rounded-input bg-app border-none cursor-pointer text-left active:bg-danger-pale transition-colors"
              >
                <Trash2 size={18} strokeWidth={2} className="text-danger shrink-0" />
                <span className="text-[14.5px] text-danger font-medium">メンバーを削除</span>
              </button>
            </div>
          </div>
        </BottomSheet>
      )}

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

      <ConfirmSheet
        isOpen={pendingTransfer !== null}
        title="オーナーを譲りますか？"
        description={pendingTransfer && (
          <>
            <span className="font-bold text-ink">{pendingTransfer.displayName}</span> を新しいオーナーにします。<br />
            あなたは編集者になり、メンバー管理・旅程削除は新しいオーナーのみが行えます。
          </>
        )}
        icon={
          <div className="w-14 h-14 rounded-2xl bg-teal-pale flex items-center justify-center">
            <Crown size={22} strokeWidth={2} className="text-teal" />
          </div>
        }
        confirmLabel={transferMut.isPending ? '譲渡中…' : '譲渡する'}
        tone="danger"
        loading={transferMut.isPending}
        onClose={() => setPendingTransfer(null)}
        onConfirm={handleConfirmTransfer}
      />

      <ConfirmSheet
        isOpen={confirmLeave}
        title="この旅程から退出しますか？"
        description={
          <>
            退出すると、再度招待されるまでこの旅程にはアクセスできなくなります。<br />
            未精算の費用がある場合も、記録は残ります。
          </>
        }
        icon={
          <div className="w-14 h-14 rounded-2xl bg-danger-pale flex items-center justify-center">
            <LogOut size={22} strokeWidth={2} className="text-[#A04040]" />
          </div>
        }
        confirmLabel="退出する"
        tone="danger"
        onClose={() => setConfirmLeave(false)}
        onConfirm={handleConfirmLeave}
      />
    </>
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
 * Role indicator chip (display-only). Role changes now happen in the member
 * action sheet (owner taps `...`), so this is always a plain badge.
 */
function RoleChip({ role }: { role: Member['role'] }) {
  const isOwner  = role === 'owner'
  const isEditor = role === 'editor'
  const label    = isOwner ? 'OWNER' : isEditor ? '編輯' : '閲覧'
  const palette  = isOwner
    ? 'bg-teal-pale text-teal border-teal/20'
    : isEditor
      ? 'bg-accent-pale text-accent border-accent/20'
      : 'bg-app text-muted border-border'

  return (
    <div className={`shrink-0 px-2 py-1 rounded-md text-[10px] font-bold tracking-[0.04em] border ${palette}`}>
      {label}
    </div>
  )
}
