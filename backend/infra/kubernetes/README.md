# Kubernetes — khung triển khai

Tách namespace, Deployment/Service cho web, API, realtime, recording và workers.
Thiết lập Ingress + TLS + WAF, HPA cho web/API/realtime và autoscale worker theo queue depth.
Media do IVS Real-Time/Composition cung cấp; không triển khai media server trong cluster.
PostgreSQL, Redis, RabbitMQ cần volume và kế hoạch backup hoặc dịch vụ managed.
Chưa cung cấp manifest production vì chưa có registry, domain, secret manager và nhà cung cấp cluster.
