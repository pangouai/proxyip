# proxyip — 出口节点

给 Cloudflare Workers（edgetunnel）做 **PROXYIP 出口跳板**的极简 TCP 转发服务。

## 它解决什么问题

edgetunnel 默认从 Cloudflare 的 IP 段访问目标网站。Google 对这些 IP 有严格限速，
所以 YouTube 只能跑 9 Mbps 左右，Buffer Health 常年 1 秒上下。

把这个服务部署到一台能 7×24 在线的机器上，在 edgetunnel 里填 `PROXYIP = <本服务地址>:8443`，
出口就变成这台机器，目标网站看到的是它的 IP。

## 协议

客户端（Cloudflare Worker）连上后：

```
→ <host>:<port>\r\n
← OK\r\n
→ 之后是纯字节流双向转发
```

同时兼容 SOCKS5（首字节 `0x05` 自动识别，无需认证）。

## 部署

见 `.github/workflows/deploy.yml`。需要以下 Secret：

| Secret | 说明 |
|---|---|
| `UNIKRAFT_TOKEN` | Unikraft Cloud API Token |

手动触发 workflow，可选参数：

- `metro`：`sin`（新加坡）/ `fra`（法兰克福）/ `sfo` / `was` / `dal`
- `action`：`deploy` / `destroy` / `status`

## 本地运行

```bash
PORT=8443 node app/proxyip.js
```

测试：

```bash
printf 'example.com:80\r\nGET / HTTP/1.0\r\nHost: example.com\r\n\r\n' | nc 127.0.0.1 8443
```

## 资源占用

128 MB 内存、1 vCPU 足够。单实例可承载数千并发连接。
