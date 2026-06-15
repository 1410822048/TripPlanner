// crispAvatarUrl の URL 改写エッジケース。旧実装の `url.split('=')[0]` は最初の
// `=` で切るため、query 付き / 複数 `=` の Google avatar URL を壊していた。path
// 末尾の size directive だけを差し替え、query を温存することを担保する。
import { describe, it, expect } from 'vitest'
import { crispAvatarUrl } from './avatarUrl'

const GOOGLE = 'https://lh3.googleusercontent.com/a/ACg8ocK_PhotoId123'

describe('crispAvatarUrl', () => {
  it('非 Google / 空 / parse 不能 URL はそのまま返す', () => {
    expect(crispAvatarUrl(undefined, 20)).toBeUndefined()
    expect(crispAvatarUrl('https://example.com/pic.jpg', 20)).toBe('https://example.com/pic.jpg')
    expect(crispAvatarUrl('not a url', 20)).toBe('not a url')
  })

  it('host が googleusercontent.com 系のときだけ改写する(substring 誤判を防ぐ)', () => {
    // query に文字列を持つ別 host — 改写してはいけない
    const q = 'https://example.com/avatar.png?src=googleusercontent.com'
    expect(crispAvatarUrl(q, 20)).toBe(q)
    // lookalike host(末尾が -googleusercontent.com で .区切りでない)
    const look = 'https://not-googleusercontent.com/a/photo'
    expect(crispAvatarUrl(look, 20)).toBe(look)
    // 本物のサブドメインは改写する
    expect(crispAvatarUrl(`${GOOGLE}=s96-c`, 20)).toMatch(/=s\d+-c$/)
  })

  it('末尾の size directive を 1 つだけ差し替える(二重付与しない)', () => {
    const out = crispAvatarUrl(`${GOOGLE}=s96-c`, 20)!
    expect(out).toMatch(/=s\d+-c$/)         // 末尾に新しい directive
    expect(out).not.toContain('s96')         // 旧 96 は消えている
    expect(out.match(/=s/g)).toHaveLength(1)  // directive は 1 つだけ
    expect(out.startsWith(GOOGLE)).toBe(true)
  })

  it('directive が無ければ末尾に付与する', () => {
    const out = crispAvatarUrl(GOOGLE, 20)!
    expect(out).toBe(`${GOOGLE}=s${out.match(/=s(\d+)-c$/)![1]}-c`)
    expect(out).toMatch(/=s\d+-c$/)
  })

  it('query string(?sz= など)を切り落とさず温存する', () => {
    const out = crispAvatarUrl(`${GOOGLE}?sz=50`, 20)!
    expect(out).toContain('?sz=50')          // 旧実装はここで壊れていた
    expect(out).toMatch(/=s\d+-c/)           // directive は path 側に付く
  })

  it('w 系 directive も差し替える', () => {
    const out = crispAvatarUrl(`${GOOGLE}=w100-h100`, 20)!
    expect(out).not.toContain('w100')
    expect(out).toMatch(/=s\d+-c$/)
  })
})
