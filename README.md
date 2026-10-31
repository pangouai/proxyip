# relay

TCP 转发工具。给 Cloudflare Workers 提供一个固定的出口地址。

## 用途

Worker 默认从 Cloudflare 的 IP 段访问目标网站，这些 IP 被部分站点限速。
把本服务部署到一台常在线的主机上，在 Worker 里填 `PROXYIP = <本服务地址>:8443`，
出口就变成这台主机。

## 协议

```
→ <host>:<port>\r\n
← OK\r\n
→ 之后是纯字节流双向转发
```

同时兼容 SOCKS5（首字节 `0x05` 自动识别，无需认证）。

## 部署

`.github/workflows/deploy.yml` 提供手动触发，需要 Secret：

| Secret | 说明 |
|---|---|
| `UKC_TOKEN` | Unikraft Cloud API Token |

参数：

- `metro`：`sin` / `fra` / `sfo` / `was` / `dal`
- `action`：`deploy` / `destroy` / `status`

## 本地运行

```bash
PORT=8443 node app/relay.js
```

测试：

```bash
printf 'example.com:80\r\nGET / HTTP/1.0\r\nHost: example.com\r\n\r\n' | nc 127.0.0.1 8443
```

## 资源占用

128 MB 内存、1 vCPU。单实例可承载数千并发连接。
