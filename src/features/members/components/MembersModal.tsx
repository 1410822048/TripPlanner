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
      toast.success(`已移除 ${target.displayName}`)
      setPendingRemove(null)  // success only → close confirm
    } catch { /* hook onError already surfaced the toast; keep sheet open */ }
  }

  async function handleConfirmTransfer() {
    if (!pendingTransfer) return
    const target = pendingTransfer
    try {
      await transferMut.mutateAsync(target.userId)
      toast.success(`已將擁有者轉讓給 ${target.displayName}`)
      setPendingTransfer(null)  // success only → close confirm
    } catch { /* MutationCache.onError already toasted; keep confirm open to retry/cancel */ }
  }

  async function handleToggleRole(m: Member) {
    if (m.role === 'owner') return
    const next = m.role === 'editor' ? 'viewer' : 'editor'
    try {
      await updateRoleMut.mutateAsync({ memberId: m.id, role: next })
      toast.success(`已將 ${m.displayName} 變更為${next === 'editor' ? '編輯者' : '檢視者'}`)
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
        <BottomSheet isOpen onClose={handleClose} title="成員管理">
          <div className="flex flex-col gap-3">
            <p className="m-0 text-[12px] text-muted leading-[1.6] tracking-[0.02em]">
              此旅程的成員清單。
              {isOwner
                ? ' 擁有者可從每位成員的「…」變更權限、轉讓擁有者或移除成員。'
                : ' 只有擁有者可以新增或移除成員。'}
            </p>

            {membersQ.isLoading ? (
              <div className="h-24 flex items-center justify-center text-muted text-[12px]">
                <LoadingText />
              </div>
            ) : membersQ.isError ? (
              <div className="py-6 text-center text-[12px] text-[#A04040] bg-danger-pale rounded-xl border border-[#E9C5C5]">
                載入失敗
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
                          {isSelf && <span className="ml-1.5 text-[10.5px] text-muted font-normal">(你)</span>}
                        </div>
                        <div className="text-[10.5px] text-muted mt-0.5">
                          {roleLabel(m.role)}
                        </div>
                      </div>
                      <RoleChip role={m.role} />
                      {canManage && (
                        <button
                          onClick={() => setActionTarget(m)}
                          aria-label={`${m.displayName} 的操作`}
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
                  退出此旅程
                </button>
              </>
            )}
          </div>
        </BottomSheet>
      )}

      {/* Per-member action sheet (owner drill-down). Mutually exclusive with
          the list + confirms. Its onClose returns to the list, not full-close. */}
      {actionTarget && !anyConfirmOpen && (
        <BottomSheet isOpen onClose={() => setActionTarget(null)} title="成員操作">
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
                  {actionTarget.role === 'editor' ? '改為檢視者' : '改為編輯者'}
                </span>
              </button>
              <button
                type="button"
                onClick={openTransferFromAction}
                className="flex items-center gap-3 px-3 min-h-12 py-2 rounded-input bg-app border-none cursor-pointer text-left active:bg-teal-pale transition-colors"
              >
                <Crown size={18} strokeWidth={2} className="text-teal shrink-0" />
                <span className="text-[14.5px] text-teal font-medium">轉讓擁有者</span>
              </button>
              <button
                type="button"
                onClick={openRemoveFromAction}
                className="flex items-center gap-3 px-3 min-h-12 py-2 rounded-input bg-app border-none cursor-pointer text-left active:bg-danger-pale transition-colors"
              >
                <Trash2 size={18} strokeWidth={2} className="text-danger shrink-0" />
                <span className="text-[14.5px] text-danger font-medium">移除成員</span>
              </button>
            </div>
          </div>
        </BottomSheet>
      )}

      <ConfirmSheet
        isOpen={pendingRemove !== null}
        title="要移除此成員嗎？"
        description={pendingRemove && (
          <>
            將從旅程移除 <span className="font-bold text-ink">{pendingRemove.displayName}</span>。<br />
            除非再次收到邀請，否則無法存取此旅程。
          </>
        )}
        icon={
          <div className="w-14 h-14 rounded-2xl bg-danger-pale flex items-center justify-center">
            <Trash2 size={22} strokeWidth={2} className="text-[#A04040]" />
          </div>
        }
        confirmLabel={removeMut.isPending ? '移除中…' : '移除'}
        tone="danger"
        loading={removeMut.isPending}
        onClose={() => setPendingRemove(null)}
        onConfirm={handleConfirmRemove}
      />

      <ConfirmSheet
        isOpen={pendingTransfer !== null}
        title="要轉讓擁有者嗎？"
        description={pendingTransfer && (
          <>
            將 <span className="font-bold text-ink">{pendingTransfer.displayName}</span> 設為新的擁有者。<br />
            你會成為編輯者，只有新的擁有者可以管理成員或刪除旅程。
          </>
        )}
        icon={
          <div className="w-14 h-14 rounded-2xl bg-teal-pale flex items-center justify-center">
            <Crown size={22} strokeWidth={2} className="text-teal" />
          </div>
        }
        confirmLabel={transferMut.isPending ? '轉讓中…' : '轉讓'}
        tone="danger"
        loading={transferMut.isPending}
        onClose={() => setPendingTransfer(null)}
        onConfirm={handleConfirmTransfer}
      />

      <ConfirmSheet
        isOpen={confirmLeave}
        title="要退出此旅程嗎？"
        description={
          <>
            退出後，在再次收到邀請前將無法存取此旅程。<br />
            即使有尚未結清的費用，紀錄仍會保留。
          </>
        }
        icon={
          <div className="w-14 h-14 rounded-2xl bg-danger-pale flex items-center justify-center">
            <LogOut size={22} strokeWidth={2} className="text-[#A04040]" />
          </div>
        }
        confirmLabel="退出旅程"
        tone="danger"
        onClose={() => setConfirmLeave(false)}
        onConfirm={handleConfirmLeave}
      />
    </>
  )
}

function roleLabel(role: Member['role']): string {
  switch (role) {
    case 'owner':  return '擁有者 · 完整管理權限'
    case 'editor': return '編輯者 · 可編輯'
    case 'viewer': return '檢視者 · 僅可查看'
  }
}

/**
 * Role indicator chip (display-only). Role changes now happen in the member
 * action sheet (owner taps `...`), so this is always a plain badge.
 */
function RoleChip({ role }: { role: Member['role'] }) {
  const isOwner  = role === 'owner'
  const isEditor = role === 'editor'
  const label    = isOwner ? 'OWNER' : isEditor ? '編輯' : '檢視'
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
