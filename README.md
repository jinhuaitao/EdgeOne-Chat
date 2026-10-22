# DDNS Master

自托管的 Cloudflare 动态域名解析面板。单个 Go 二进制，内置全部前端资源，无 Node.js、无 CDN、无外部数据库，适合家庭宽带、NAS 与 VPS。

## 核心特性

| 能力 | 说明 |
| --- | --- |
| 双栈解析 | A（IPv4）与 AAAA（IPv6），同一面板混合管理 |
| IP 来源 | 自动获取公网 IP（ipify / icanhazip / ip.sb 容错）或指定本机网卡 |
| Zone 定位 | 根据域名后缀自动匹配 Cloudflare Zone，无需手填 Zone ID |
| 记录维护 | 自动创建缺失记录、修正 IP 漂移、同步 TTL 与代理开关 |
| 安全防护 | 同名记录重复检测，避免误改多条解析 |
| 调度 | 1–1440 分钟可调，支持手动立即同步；新增或修改域名后自动触发 |
| 通知 | Telegram Bot 推送记录创建与 IP 变更 |
| 可观测 | 每个域名的状态、最后检查/变更时间、错误原因；变更历史与系统日志 |
| 备份迁移 | 导出/导入 JSON，兼容旧版备份；恢复时按域名合并，不覆盖无关数据 |
| 界面 | 响应式桌面/移动布局，明暗主题，无刷新增删改与确认对话框 |
| 部署 | systemd / OpenRC 服务，独立低权限运行用户，单文件升级与回滚 |

## 快速开始

### 一键安装

```bash
curl -fsSL https://github.com/jinhuaitao/ddns/releases/latest/download/install.sh -o install.sh
sudo sh install.sh install
```

安装完成后访问 `http://服务器IP:8080`，创建管理员账号，然后：

1. 打开「系统设置」，填入 Cloudflare API Token 并保存。
2. 回到仪表盘「添加域名」，输入完整域名（如 `home.example.com`），选择记录类型与 IP 来源。
3. 点击「立即同步」验证，之后由调度器自动维护。

Cloudflare Token 需要两项权限，并限定到实际使用的 Zone：

```text
Zone   / Zone / Read
Zone   / DNS  / Edit
```

### 离线或自定义安装

```bash
# 使用本地二进制（linux-amd64 / linux-arm64）
sudo sh install.sh install --from-file ./ddns-linux-amd64

# 自定义监听地址与数据目录
sudo sh install.sh install --addr 127.0.0.1:8080 --data-dir /var/lib/ddns

# 指定版本
sudo sh install.sh install --version v1.2.3
```

脚本会校验二进制的 `version` 输出，并在发布方提供 `SHA256SUMS` 时校验完整性。下载失败会自动尝试镜像，也可通过环境变量控制：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `DDNS_REPO` | `jinhuaitao/ddns` | 指向自己的 Fork |
| `DDNS_MIRROR_PREFIX` | `https://jht126.eu.org/` | GitHub 加速前缀，设为空则只用官方地址 |
| `DDNS_DOWNLOAD_BASE` | 空 | 直接指定二进制所在目录，优先级最高 |

## 服务管理

```bash
sudo sh install.sh status      # 服务状态、版本、访问地址
sudo sh install.sh update      # 下载并安装最新版，失败自动回滚
sudo sh install.sh restart
sudo sh install.sh logs        # 持续跟随日志
sudo sh install.sh uninstall   # 卸载服务，保留数据库与账号
sudo sh install.sh uninstall --purge --yes   # 同时删除面板数据库与账号
```

安装布局：

| 内容 | 路径 |
| --- | --- |
| 二进制 | `/usr/local/bin/ddns` |
| 数据目录 | `/etc/ddns`（权限 `0700`，属主 `ddns`） |
| 数据库 | `/etc/ddns/ddns_panel.db` |
| 环境变量 | `/etc/ddns.env`（权限 `0600`） |
| 服务单元 | systemd: `/etc/systemd/system/ddns.service`；OpenRC: `/etc/init.d/ddns` |
| 旧版备份 | `/usr/local/bin/ddns.bak` |

修改 `/etc/ddns.env` 后执行 `sudo sh install.sh restart` 生效。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DDNS_ADDR` | `:8080` | 监听地址，例如 `127.0.0.1:8080` |
| `DDNS_DATA_DIR` | `.`（安装后为 `/etc/ddns`） | SQLite 与会话密钥所在目录 |
| `DDNS_COOKIE_SECURE` | `auto` | `auto` 按 TLS / `X-Forwarded-Proto` 判断；反代未透传时设为 `true` |
| `DDNS_DEBUG` | 空 | `1` 开启 Gin 调试日志 |

### 反向代理

面板本身不处理 TLS。建议只监听回环地址，由 Nginx/Caddy 终止 HTTPS：

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

若代理未传递 `X-Forwarded-Proto`，请在环境文件中设置 `DDNS_COOKIE_SECURE=true`。

### 重置管理员

```bash
sudo systemctl stop ddns
sudo -u ddns env DDNS_DATA_DIR=/etc/ddns /usr/local/bin/ddns reset-admin
sudo systemctl start ddns
```

命令会生成随机密码并打印一次；可附加用户名，例如 `reset-admin admin`。OpenRC 用户将 `systemctl` 换成 `rc-service ddns`。

## 安全设计

- 密码使用 bcrypt 哈希；连续 5 次失败锁定 15 分钟。
- 会话 Cookie 为 `HttpOnly`、`SameSite=Lax`、7 天有效，签名密钥随机生成并持久化。
- 所有写操作使用 POST，并校验 CSRF Token；登录后跳转地址经过白名单过滤。
- 严格 CSP（禁止内联脚本与第三方资源）、`frame-ancestors 'none'`、请求体大小限制。
- 服务以独立 `ddns` 用户运行，systemd 启用 `NoNewPrivileges`、`ProtectSystem=strict` 等加固。
- `/healthz` 无需登录，仅返回版本、运行时长与同步状态。

数据库与导出的备份都包含 Cloudflare Token、Telegram Token 等敏感信息，请限制文件权限并妥善保管备份。

## 备份与恢复

「系统设置 → 数据备份」可导出 JSON（含设置与域名），用于迁移或灾备。

- 恢复按 `域名 + 记录类型` 合并：已存在则更新，不存在则新增，不会删除当前多余域名。
- 恢复后 Zone 缓存会重新定位，记录状态回到「等待同步」。
- 旧版备份（无 `app` 字段）可直接导入。

## 常见问题

<details>
<summary>添加域名提示「定位 Zone 失败」</summary>

确认 Token 具备 `Zone:Read`，且该域名确实在当前 Cloudflare 账号下；检查域名拼写与服务器到 `api.cloudflare.com` 的网络。
</details>

<details>
<summary>AAAA 记录提示无法获取公网 IPv6</summary>

自动获取需要服务器自身具备 IPv6 出口。若只有内网 IPv6，请把 IP 来源改为「本机网卡」并选择对应接口。
</details>

<details>
<summary>TTL 显示为「自动」</summary>

记录开启 Cloudflare 代理（橙色云朵）时，Cloudflare 强制使用自动 TTL，面板会按此预期同步。
</details>

<details>
<summary>Telegram 收不到通知</summary>

先点击设置页的「发送测试」；确认 Chat ID 正确、Bot 已被拉入会话并发送过 `/start`。通知仅在记录创建或 IP 变化时发送。
</details>

<details>
<summary>忘记密码 / 账号被锁定</summary>

等待 15 分钟，或使用上面的 `reset-admin` 命令重置。
</details>

<details>
<summary>卸载会删除数据吗</summary>

默认不会，仅移除服务和二进制；重新安装后沿用原账号与域名。使用 `--purge` 才会删除面板数据库与账号，数据目录中的其他文件会被保留。
</details>

## 从源码构建

需要 Go 1.24 或更高版本。

```bash
go test ./...
go vet ./...
go build -trimpath -ldflags "-s -w -X main.Version=dev" -o ddns .
DDNS_DATA_DIR=./data ./ddns
```

项目结构：

| 路径 | 职责 |
| --- | --- |
| `main.go` | 启动、命令行、路由装配 |
| `handlers_*.go` | 页面、表单操作、JSON API |
| `sync.go` / `cloudflare.go` | 同步引擎、Zone 定位与 Cloudflare 调用 |
| `ip.go` / `notify.go` / `scheduler.go` | IP 获取、Telegram、定时调度 |
| `auth.go` / `store.go` / `backup.go` | 会话安全、数据库、备份导入导出 |
| `templates/` / `static/` | 内嵌模板、样式与脚本 |

CI 会在每次推送和 PR 时执行 `gofmt`、`go vet`、测试与构建；推送 `v*` 标签时发布 `ddns-linux-amd64`、`ddns-linux-arm64`、`install.sh` 与 `SHA256SUMS`。
