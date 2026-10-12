// crispAvatarUrl 的 URL 改寫邊界案例。舊實作的 `url.split('=')[0]` 在第一個
// `=` 就切斷,會破壞帶 query / 多個 `=` 的 Google avatar URL。確保只替換 path
// 結尾的 size directive,並保留 query。
import { describe, it, expect } from 'vitest'
import { crispAvatarUrl } from './avatarUrl'

const GOOGLE = 'https://lh3.googleusercontent.com/a/ACg8ocK_PhotoId123'

describe('crispAvatarUrl', () => {
  it('非 Google / 空字串 / 無法解析的 URL 原樣回傳', () => {
    expect(crispAvatarUrl(undefined, 20)).toBeUndefined()
    expect(crispAvatarUrl('https://example.com/pic.jpg', 20)).toBe('https://example.com/pic.jpg')
    expect(crispAvatarUrl('not a url', 20)).toBe('not a url')
  })

  it('只有 host 屬於 googleusercontent.com 系列時才改寫(避免 substring 誤判)', () => {
    // query 中帶該字串的其他 host — 不可改寫
    const q = 'https://example.com/avatar.png?src=googleusercontent.com'
    expect(crispAvatarUrl(q, 20)).toBe(q)
    // lookalike host(結尾是 -googleusercontent.com,不是以 . 分隔)
    const look = 'https://not-googleusercontent.com/a/photo'
    expect(crispAvatarUrl(look, 20)).toBe(look)
    // 真正的子網域要改寫
    expect(crispAvatarUrl(`${GOOGLE}=s96-c`, 20)).toMatch(/=s\d+-c$/)
  })

  it('只替換結尾的一個 size directive(不重複附加)', () => {
    const out = crispAvatarUrl(`${GOOGLE}=s96-c`, 20)!
    expect(out).toMatch(/=s\d+-c$/)         // 結尾是新的 directive
    expect(out).not.toContain('s96')         // 舊的 96 已消失
    expect(out.match(/=s/g)).toHaveLength(1)  // directive 只有 1 個
    expect(out.startsWith(GOOGLE)).toBe(true)
  })

  it('沒有 directive 時附加在結尾', () => {
    const out = crispAvatarUrl(GOOGLE, 20)!
    expect(out).toBe(`${GOOGLE}=s${out.match(/=s(\d+)-c$/)![1]}-c`)
    expect(out).toMatch(/=s\d+-c$/)
  })

  it('保留 query string(?sz= 等),不截掉', () => {
    const out = crispAvatarUrl(`${GOOGLE}?sz=50`, 20)!
    expect(out).toContain('?sz=50')          // 舊實作在這裡會壞掉
    expect(out).toMatch(/=s\d+-c/)           // directive 加在 path 那側
  })

  it('w 系列 directive 也會替換', () => {
    const out = crispAvatarUrl(`${GOOGLE}=w100-h100`, 20)!
    expect(out).not.toContain('w100')
    expect(out).toMatch(/=s\d+-c$/)
  })
})
