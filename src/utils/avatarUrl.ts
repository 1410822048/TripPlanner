// src/utils/avatarUrl.ts
// Google プロフィール写真(lh3.googleusercontent.com)の解像度を表示サイズに
// 合わせて crisp 化する純関数。MemberAvatar 専用ロジックだが、Fast Refresh の
// 制約(component 檔は component のみ export)を避けるため util に切り出す。

/** Google profile photos(lh3.googleusercontent.com)carry a size directive
 *  appended to the PATH after `=`(e.g. `…/ACg8=s96-c` → 96px cropped square).
 *  The stored default is often coarse for the small diameters we render at, so
 *  on retina a 20px avatar upscaled from a low-res crop looks pixelated.
 *  Re-request the photo at displayPx × devicePixelRatio(min 64, max 256,
 *  square-cropped)so it renders crisp. Non-Google URLs are returned unchanged. */
export function crispAvatarUrl(url: string | undefined, displayPx: number): string | undefined {
  if (!url) return url
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return url // 相対 URL など parse 不能はそのまま
  }
  // Gate on the parsed hostname — a substring check would wrongly match
  // lookalikes(not-googleusercontent.com)や query にその文字列を持つ別 host
  // (…?src=googleusercontent.com)まで改写してしまう。実 host は
  // lh3.googleusercontent.com など。
  const host = u.hostname
  if (host !== 'googleusercontent.com' && !host.endsWith('.googleusercontent.com')) {
    return url
  }
  const dpr    = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 2
  const target = Math.min(Math.max(Math.ceil(displayPx * dpr), 64), 256)
  // The size directive is a path-style suffix, NOT a query param. Only touch
  // the path: replace a trailing `=s<N>…` / `=w<N>…` directive and leave any
  // `?query`(sz=, auth tokens, …)intact. The old `url.split('=')[0]`
  // truncated at the FIRST `=`, corrupting query-bearing or multi-`=` URLs.
  u.pathname = u.pathname.replace(/=[sw]\d+(?:-[a-z0-9]+)*$/i, '') + `=s${target}-c`
  return u.toString()
}
