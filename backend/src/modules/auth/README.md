# Xác thực và phiên T01

`AuthModule` triển khai đăng ký, đăng nhập, refresh rotation và logout.
`SessionSecurityModule` cung cấp AccessTokenGuard và SessionStore cho các module khác.
Quy ước nằm ở [backend/README.md](../../../README.md), ví dụ gọi API ở
[auth-api.md](../../../docs/auth-api.md).
Phân quyền OWNER/HOST/VIEWER theo group thuộc T03.
