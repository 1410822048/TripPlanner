// src/types/notificationRoute.ts
// 通知導向的白名單常數。刻意不 import zod：Service Worker 也讀這份清單
// （src/services/notificationOpenProtocol.ts），zod 進 SW bundle 不划算。
// Zod schema 由 ./notification.ts 以同一份 tuple 建立，兩邊不會漂移。

export const NOTIFICATION_ROUTES = ['/schedule', '/expense', '/bookings', '/wish', '/planning', '/account'] as const
export type NotificationRoute = typeof NOTIFICATION_ROUTES[number]

/** 'trip'：收件人仍是該旅程成員；'account'：收件人已失去旅程存取
 *  （member.removed_self），只能導向 /account。 */
export const NOTIFICATION_SCOPES = ['trip', 'account'] as const
export type NotificationScope = typeof NOTIFICATION_SCOPES[number]
