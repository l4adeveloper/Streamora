# Kubernetes — khung triển khai

Tách namespace, Deployment/Service cho web, API, realtime, recording và workers.
Thiết lập Ingress + TLS + WAF, HPA cho web/API/realtime và autoscale worker theo queue depth.
LiveKit yêu cầu cấu hình UDP/TURN và mạng phù hợp; Egress cần tài nguyên riêng.
PostgreSQL, Redis, RabbitMQ cần volume và kế hoạch backup hoặc dịch vụ managed.
Chưa cung cấp manifest production vì chưa có registry, domain, secret manager và nhà cung cấp cluster.
