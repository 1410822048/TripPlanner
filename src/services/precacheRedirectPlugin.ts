import { copyResponse, type WorkboxPlugin } from 'workbox-core'

// Cloudflare Pages 將 /index.html 重新導向 /。預快取缺漏時，Workbox
// 的網路回退會直接回傳 redirected response，導致導覽以 ERR_FAILED 失敗。
// 在 fetch 邊界正規化，讓首頁與深層路由都能回復；copyResponse 保留同源檢查。
// 不自行補寫帶 revision 的快取，避免把新版 HTML 寫進舊版 worker 的快取。
export const precacheRedirectPlugin: WorkboxPlugin = {
  async fetchDidSucceed({ response }) {
    return response.redirected ? copyResponse(response) : response
  },
}
