// src/components/ui/TripLoading.tsx
// Centred loading screen used while useTripContext is still resolving.
import LoadingText from './LoadingText'

export default function TripLoading() {
  return (
    <div className="bg-app min-h-full flex items-center justify-center text-muted text-[13px]">
      <LoadingText />
    </div>
  )
}
