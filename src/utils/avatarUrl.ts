// src/utils/avatarUrl.ts
// 把 Google 個人照片(lh3.googleusercontent.com)的解析度配合顯示尺寸
// 調成 crisp 的純函式。雖然是 MemberAvatar 專用邏輯,但為了避開 Fast Refresh 的
// 限制(component 檔只能 export component)而抽成 util。

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
    return url // 相對 URL 等無法 parse 的原樣回傳
  }
  // Gate on the parsed hostname — a substring check would wrongly match
  // lookalikes(not-googleusercontent.com)或 query 中帶該字串的其他 host
  // (…?src=googleusercontent.com)也一併改寫。實際 host 是
  // lh3.googleusercontent.com 等。
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
