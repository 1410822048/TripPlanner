import type { Booking } from '@/types'

export interface BookingPassTone {
  from: string
  to: string
  ink: string
}

export const BOOKING_PASS_TONE: Record<Booking['type'], BookingPassTone> = {
  flight: { from: '#3D8B7A', to: '#7FB7A9', ink: '#FFFFFF' },
  hotel:  { from: '#D3A94E', to: '#F1D38A', ink: '#1F2A2E' },
  train:  { from: '#4D7595', to: '#8EB6CF', ink: '#FFFFFF' },
  bus:    { from: '#7C8A62', to: '#B8C58D', ink: '#1F2A2E' },
  other:  { from: '#7E6F9B', to: '#B6A9CF', ink: '#FFFFFF' },
}
