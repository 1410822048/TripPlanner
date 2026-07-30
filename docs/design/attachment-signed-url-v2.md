# Attachment signed URL V2（已退役）

> 狀態：**SUPERSEDED**。原本的 Firebase Storage `getBlob`／GCS V4 signed URL
> 雙路徑已在 R2 遷移中移除；本檔只保留決策墓碑，避免舊連結失效。

退役原因：

- GCS signer 需要 service-account RSA 私鑰與 Storage IAM，擴大憑證面。
- signed URL 是 TTL 內有效的 bearer capability，成員撤權不會立即失效。
- thumb 批次簽章、TTL cache、refresh skew 與 mode flag 增加雙路徑認知負載。
- Cloudflare Worker 可直接以 private R2 binding 串流內容，無需 S3 credentials 或公開 bucket。

目前架構與部署／回滾規則請見
[Private R2 attachment proxy](./attachment-r2-proxy.md)。
