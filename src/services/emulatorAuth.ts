import { FIREBASE_EMULATOR_MODE, getFirebaseAuth } from './firebase'

export type EmulatorRole = 'owner' | 'editor' | 'viewer'

export const DEV_EMULATOR_PASSWORD = import.meta.env.VITE_DEV_EMULATOR_PASSWORD ?? 'tripmate-dev-password'

export const DEV_EMULATOR_USERS: Record<EmulatorRole, { email: string; label: string }> = {
  owner:  { email: 'dev-owner@localhost.test',  label: 'DEV owner' },
  editor: { email: 'dev-editor@localhost.test', label: 'DEV editor' },
  viewer: { email: 'dev-viewer@localhost.test', label: 'DEV viewer' },
}

/** Local-only role login. This function is unreachable in production builds
 * because the caller is gated by both Vite DEV and Firebase emulator mode. */
export async function signInWithEmulatorRole(role: EmulatorRole): Promise<void> {
  if (!import.meta.env.DEV || !FIREBASE_EMULATOR_MODE) {
    throw new Error('Emulator role login is available only in local development')
  }
  const account = DEV_EMULATOR_USERS[role]
  const { auth, signInWithEmailAndPassword } = await getFirebaseAuth()
  await signInWithEmailAndPassword(auth, account.email, DEV_EMULATOR_PASSWORD)
}
