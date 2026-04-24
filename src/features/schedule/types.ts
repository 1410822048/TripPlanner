// src/features/schedule/types.ts
export interface TripMember {
  id:    string
  label: string   // 單字頭像文字，如 '我'、'友'
  color: string   // 文字色
  bg:    string   // 底色
}

export interface TripItem {
  id:        string
  title:     string
  dest:      string
  emoji:     string
  startDate: string
  endDate:   string
  members:   TripMember[]
}

export type MenuActionKey = 'edit' | 'members' | 'copy' | 'share' | 'settings'
