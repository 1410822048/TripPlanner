// Shared gesture constants for SwipeableTripItem / SwipeableExpenseItem.
// Keep in lockstep across all swipe-to-delete rows for consistent feel.

export const SWIPE_WIDTH     = 84   // px — width of the red delete background revealed on swipe
export const OPEN_THRESHOLD  = 42   // px — drag past this to latch open on release
export const MOVE_THRESHOLD  = 6    // px — horizontal movement required before committing to a swipe

export const FG_TRANSITION = 'transform 0.25s cubic-bezier(0.32,0.72,0,1)'
export const BG_TRANSITION = 'transform 0.25s cubic-bezier(0.32,0.72,0,1), background 0.15s'
