// Shared palette & sizing for date / time pickers.
// Colors are kept here (instead of the global theme) because they're
// only meaningful within the calendar / wheel context.

export const PICKER_COLORS = {
  today:    '#C09060',
  todayBg:  '#FDF0E4',
  sunday:   '#C07070',
  saturday: '#7090C0',
  disabled: '#D5D0CA',
} as const

// Wheel picker geometry — used by TimePicker
export const WHEEL_ITEM_HEIGHT = 40
export const WHEEL_VISIBLE     = 5
export const WHEEL_PAD_ROWS    = Math.floor(WHEEL_VISIBLE / 2)
