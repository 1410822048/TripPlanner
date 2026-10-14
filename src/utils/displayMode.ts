// Whether the app runs as an installed PWA (home-screen window). The
// display-mode media query covers every supported client (iOS 18+,
// Chrome 125+), so the old iOS-only `navigator.standalone` is not needed.
export function isStandalonePwa(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia?.('(display-mode: standalone)').matches === true
}
