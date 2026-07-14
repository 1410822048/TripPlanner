// src/features/members/components/SocialCirclePage.tsx
// "社交圈" — shows every non-self person who shares at least one trip with
// the signed-in user. Each row aggregates the trips they co-appear in, with
// per-trip role. Data pipeline:
//   1. useMyTrips → list of trips I'm a member of (from tripService'
//      collection-group query).
//   2. useQueries → fan out to /trips/{id}/members for each of those trips
//      (shared cache with useMembers elsewhere).
//   3. Aggregate all (member, trip) pairs, group by userId, drop self.
//   4. Sort collaborators by # shared trips desc, then displayName.
// Reads per visit: N getDocs where N = user's trip count. Typical <20;
// cached across MembersModal / AccountPage / this page.
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, ChevronRight } from 'lucide-react'
import { useUid } from '@/hooks/useAuth'
import { useAllTripMembers } from '@/features/members/hooks/useAllTripMembers'
import { memberToTripMember } from '@/features/members/utils'
import { useTripStore } from '@/store/tripStore'
import LoadingText from '@/components/ui/LoadingText'
import MemberAvatar from '@/components/ui/MemberAvatar'
import type { TripMember } from '@/features/trips/types'
import type { Member } from '@/types'

interface CollaboratorTrip {
  tripId:    string
  tripTitle: string
  tripIcon:  string
  role:      Member['role']
}

interface Collaborator {
  userId:      string
  displayName: string
  chip:        TripMember
  trips:       CollaboratorTrip[]
}

function roleLabel(role: Member['role']): string {
  switch (role) {
    case 'owner':  return '擁有者'
    case 'editor': return '編輯者'
    case 'viewer': return '檢視者'
  }
}

export default function SocialCirclePage() {
  const navigate          = useNavigate()
  const uid               = useUid()
  const setSelectedTripId = useTripStore(s => s.setSelectedTripId)
  const { trips, memberResults, isLoading: loading } = useAllTripMembers(uid)

  // Aggregate collaborators across every trip. Key by userId so the same
  // person appearing in multiple trips collapses into one row. Memoised
  // on the upstream data so unrelated re-renders (navigation, focus
  // changes) don't re-bucket O(trips × members).
  const collaborators = (() => {
    const byUser = new Map<string, Collaborator>()
    ;(trips ?? []).forEach((trip, i) => {
      const members = memberResults[i]?.data ?? []
      for (const m of members) {
        if (m.userId === uid) continue
        let existing = byUser.get(m.userId)
        if (!existing) {
          existing = {
            userId:      m.userId,
            displayName: m.displayName,
            chip:        memberToTripMember(m),
            trips:       [],
          }
          byUser.set(m.userId, existing)
        }
        // Guard against accidental duplicate insertions if the member
        // doc somehow appears twice — unlikely but defensive.
        if (!existing.trips.some(t => t.tripId === trip.id)) {
          existing.trips.push({
            tripId:    trip.id,
            tripTitle: trip.title,
            tripIcon:  trip.icon ?? '✈️',
            role:      m.role,
          })
        }
      }
    })
    return Array.from(byUser.values()).sort((a, b) => {
      if (b.trips.length !== a.trips.length) return b.trips.length - a.trips.length
      return a.displayName.localeCompare(b.displayName)
    })
  })()

  function openTrip(t: CollaboratorTrip) {
    // Just pin the id — the full Trip object is already in the React
    // Query cache (useAllTripMembers pulled it in), and useCurrentTrip
    // on /schedule will derive from there.
    setSelectedTripId(t.tripId)
    navigate('/schedule')
  }

  return (
    <div className="fixed inset-0 max-w-[430px] mx-auto bg-app flex flex-col overflow-y-auto">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 pt-4 pb-2 shrink-0">
        <button
          onClick={() => navigate(-1)}
          aria-label="返回"
          className="w-9 h-9 rounded-full flex items-center justify-center text-ink hover:bg-tile transition-colors cursor-pointer"
        >
          <ArrowLeft size={18} strokeWidth={2} />
        </button>
      </div>
      <div className="px-5 pb-4 shrink-0">
        <h1 className="m-0 text-[26px] font-black text-ink -tracking-[0.4px] leading-[1.1]">
          社交圈
        </h1>
        <p className="m-0 mt-1.5 text-[12px] text-muted leading-[1.6] tracking-[0.02em]">
          曾一起規劃旅程的旅伴清單。
        </p>
      </div>

      {/* Body */}
      {!uid ? (
        <EmptyState
          emoji="☁️"
          title="需要登入"
          description="請登入以查看曾一起規劃旅程的旅伴。"
        />
      ) : loading ? (
        <div className="flex-1 flex items-center justify-center text-muted text-[13px]">
          <LoadingText />
        </div>
      ) : collaborators.length === 0 ? (
        <EmptyState
          emoji="🧑‍🤝‍🧑"
          title="尚未有旅伴"
          description="邀請旅伴加入旅程後，會顯示在這裡。"
        />
      ) : (
        <div className="px-4 pb-10 flex flex-col gap-3">
          {collaborators.map(c => (
            <CollaboratorCard key={c.userId} collaborator={c} onTripTap={openTrip} />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Subcomponents ──────────────────────────────────────────────

function CollaboratorCard({ collaborator, onTripTap }: {
  collaborator: Collaborator
  onTripTap:    (t: CollaboratorTrip) => void
}) {
  const { chip, displayName, trips } = collaborator
  return (
    <div className="bg-surface border border-border rounded-[20px] p-4 shadow-[0_2px_12px_rgba(0,0,0,0.05)]">
      {/* Header: avatar + name + trip count */}
      <div className="flex items-center gap-3">
        <MemberAvatar
          member={chip}
          size={48}
          className="text-[15px] shadow-[0_1px_4px_rgba(0,0,0,0.08)]"
        />
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-black text-ink truncate -tracking-[0.1px]">
            {displayName}
          </div>
          <div className="text-[10.5px] text-muted mt-0.5 tracking-[0.04em]">
            {trips.length} 趟旅程
          </div>
        </div>
      </div>

      {/* Trip list — each row tappable, jumps to /schedule with that trip selected */}
      <ul className="mt-3 flex flex-col gap-1.5 list-none m-0 p-0">
        {trips.map(t => (
          <li key={t.tripId}>
            <button
              onClick={() => onTripTap(t)}
              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl border-none bg-app cursor-pointer hover:bg-tile transition-colors text-left"
            >
              <div className="w-8 h-8 rounded-lg shrink-0 flex items-center justify-center text-[16px] bg-surface shadow-[inset_0_1px_2px_rgba(0,0,0,0.05)]">
                {t.tripIcon}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] font-semibold text-ink truncate">
                  {t.tripTitle}
                </div>
                <div className="text-[10.5px] text-muted mt-0.5">
                  {roleLabel(t.role)}
                </div>
              </div>
              <ChevronRight size={13} strokeWidth={2} className="text-muted shrink-0" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function EmptyState({ emoji, title, description }: {
  emoji:       string
  title:       string
  description: string
}) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-8 text-center gap-2">
      <div className="text-[40px] leading-none mb-2">{emoji}</div>
      <h2 className="m-0 text-[15px] font-bold text-ink tracking-[0.02em]">
        {title}
      </h2>
      <p className="m-0 text-[12px] text-muted leading-[1.7] max-w-[280px]">
        {description}
      </p>
    </div>
  )
}
