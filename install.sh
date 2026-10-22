#!/bin/sh
# DDNS Master installer / manager
# Supports systemd (Debian, Ubuntu, etc.) and OpenRC (Alpine).

set -u

REPO="${DDNS_REPO:-jinhuaitao/ddns}"
ASSET_PREFIX="ddns-linux"
BIN_PATH="/usr/local/bin/ddns"
DEFAULT_DATA_DIR="/etc/ddns"
ENV_FILE="/etc/ddns.env"
SYSTEMD_PATH="/etc/systemd/system/ddns.service"
OPENRC_PATH="/etc/init.d/ddns"
SERVICE_NAME="ddns"
SERVICE_USER="ddns"
SERVICE_GROUP="ddns"

if [ -t 1 ]; then
    GREEN='\033[0;32m'
    RED='\033[0;31m'
    YELLOW='\033[0;33m'
    BLUE='\033[0;36m'
    BOLD='\033[1m'
    NC='\033[0m'
else
    GREEN=''; RED=''; YELLOW=''; BLUE=''; BOLD=''; NC=''
fi

say()  { printf "${GREEN}%s${NC}\n" "$*"; }
info() { printf "${BLUE}%s${NC}\n" "$*"; }
warn() { printf "${YELLOW}%s${NC}\n" "$*"; }
fail() { printf "${RED}%s${NC}\n" "$*" >&2; exit 1; }
die()  { fail "$*"; }

usage() {
    cat <<EOF
${BOLD}DDNS Master 管理脚本${NC}

用法:
  install.sh <命令> [选项]

命令:
  install       安装或覆盖安装（保留已有数据）
  update        更新到最新版本（保留配置与数据库）
  uninstall     卸载服务（默认保留数据）
  status        查看服务、版本与访问地址
  start         启动服务
  stop          停止服务
  restart       重启服务
  logs          查看日志（终端中会持续跟随）
  help          显示本帮助

选项:
  --version TAG       指定 Release 标签，例如 v1.2.3；默认 latest
  --from-file FILE    使用本地二进制文件安装或更新
  --addr ADDR         监听地址，默认 :8080
  --data-dir DIR      数据目录，默认 /etc/ddns
  --cookie-secure M   auto | true | false，默认 auto
  --yes, -y           非交互确认
  --purge             卸载时同时删除数据与账号（谨慎）
  --no-start          安装/更新后不启动服务

示例:
  sudo sh install.sh install
  sudo sh install.sh update --version v1.2.3
  sudo sh install.sh uninstall --purge --yes

环境变量:
  DDNS_REPO           默认 jinhuaitao/ddns
  DDNS_MIRROR_PREFIX  下载镜像前缀，留空则仅使用 GitHub
  DDNS_DOWNLOAD_BASE  自定义二进制下载目录（优先级最高）

安装目录:
  二进制  $BIN_PATH
  数据    $DEFAULT_DATA_DIR（可通过 --data-dir 修改）
  环境    $ENV_FILE
EOF
}

load_existing_config() {
    ADDR=":8080"
    DATA_DIR="$DEFAULT_DATA_DIR"
    COOKIE_SECURE="auto"
    if [ -r "$ENV_FILE" ]; then
        ADDR=$(env_value DDNS_ADDR "$ADDR")
        DATA_DIR=$(env_value DDNS_DATA_DIR "$DATA_DIR")
        COOKIE_SECURE=$(env_value DDNS_COOKIE_SECURE "$COOKIE_SECURE")
    fi
}

env_value() {
    key="$1"
    default="$2"
    [ -r "$ENV_FILE" ] || { printf '%s' "$default"; return; }
    value=$(grep -E "^[[:space:]]*${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2-)
    value=$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//')
    if [ -n "$value" ]; then
        printf '%s' "$value"
    else
        printf '%s' "$default"
    fi
}

require_root() {
    [ "$(id -u)" -eq 0 ] || fail "请使用 root 权限运行，例如：sudo sh install.sh ${COMMAND}"
}

validate_inputs() {
    case "$VERSION" in
        *[!A-Za-z0-9._-]*) fail "--version 只能包含字母、数字、点、下划线和连字符" ;;
    esac
    case "$ADDR" in
        ''|*[!A-Za-z0-9.:\[\]_-]*) fail "--addr 格式不正确，例如 :8080、127.0.0.1:8080 或 [::]:8080" ;;
    esac
    case "$DATA_DIR" in
        /*) ;;
        *) fail "--data-dir 必须是绝对路径" ;;
    esac
    case "$DATA_DIR" in
        *[!A-Za-z0-9/_.-]*) fail "--data-dir 只支持字母、数字、/、_、. 和 -" ;;
    esac
    case "/$DATA_DIR/" in
        */../*) fail "--data-dir 不能包含 .. 路径片段" ;;
    esac
    case "$DATA_DIR" in
        /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/media|/mnt|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var)
            fail "--data-dir 不能使用系统目录：$DATA_DIR" ;;
    esac
    case "$COOKIE_SECURE" in
        auto|true|false) ;;
        *) fail "--cookie-secure 只能是 auto、true 或 false" ;;
    esac
}

detect_platform() {
    case "$(uname -s)" in
        Linux) ;;
        *) fail "该脚本仅支持 Linux；本地开发请直接运行 go run ." ;;
    esac

    case "$(uname -m)" in
        x86_64|amd64) ARCH="amd64" ;;
        aarch64|arm64) ARCH="arm64" ;;
        *) fail "暂不支持当前架构 $(uname -m)，仅提供 linux/amd64 与 linux/arm64" ;;
    esac

    if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
        INIT_SYSTEM="systemd"
    elif command -v rc-service >/dev/null 2>&1 && command -v rc-update >/dev/null 2>&1; then
        INIT_SYSTEM="openrc"
    else
        fail "未检测到 systemd 或 OpenRC，无法安装系统服务"
    fi

    if [ -f /etc/alpine-release ]; then
        PKG_FAMILY="alpine"
    else
        PKG_FAMILY="linux"
    fi
}

user_exists() { id -u "$1" >/dev/null 2>&1; }
group_exists() { getent group "$1" >/dev/null 2>&1 || grep -q "^$1:" /etc/group 2>/dev/null; }

ensure_service_user() {
    if [ "$PKG_FAMILY" = "alpine" ]; then
        group_exists "$SERVICE_GROUP" || addgroup -S "$SERVICE_GROUP" || fail "创建服务用户组失败"
        if ! user_exists "$SERVICE_USER"; then
            adduser -S -D -H -h "$DATA_DIR" -s /sbin/nologin -G "$SERVICE_GROUP" "$SERVICE_USER" \
                || fail "创建服务用户失败"
        fi
    else
        group_exists "$SERVICE_GROUP" || groupadd -r "$SERVICE_GROUP" || fail "创建服务用户组失败"
        if ! user_exists "$SERVICE_USER"; then
            NOLOGIN=$(command -v nologin 2>/dev/null || printf '/bin/false')
            useradd -r -M -g "$SERVICE_GROUP" -d "$DATA_DIR" -s "$NOLOGIN" "$SERVICE_USER" \
                || fail "创建服务用户失败"
        fi
    fi
}

prepare_data_dir() {
    mkdir -p "$DATA_DIR" || fail "创建数据目录失败: $DATA_DIR"
    chown -R "$SERVICE_USER:$SERVICE_GROUP" "$DATA_DIR" || fail "设置数据目录权限失败"
    chmod 700 "$DATA_DIR" || true
}

is_active() {
    if [ "${INIT_SYSTEM:-}" = "systemd" ]; then
        systemctl is-active --quiet "$SERVICE_NAME.service"
    elif [ "${INIT_SYSTEM:-}" = "openrc" ]; then
        rc-service "$SERVICE_NAME" status >/dev/null 2>&1
    else
        return 1
    fi
}

service_installed() {
    [ -x "$BIN_PATH" ] && { [ -f "$SYSTEMD_PATH" ] || [ -f "$OPENRC_PATH" ]; }
}

stop_service() {
    if [ "${INIT_SYSTEM:-}" = "systemd" ]; then
        systemctl stop "$SERVICE_NAME.service" >/dev/null 2>&1 || true
    elif [ "${INIT_SYSTEM:-}" = "openrc" ]; then
        rc-service "$SERVICE_NAME" stop >/dev/null 2>&1 || true
    fi
}

start_service() {
    if [ "${INIT_SYSTEM:-}" = "systemd" ]; then
        systemctl daemon-reload || fail "systemctl daemon-reload 失败"
        systemctl enable "$SERVICE_NAME.service" >/dev/null 2>&1 || true
        if [ "$NO_START" -eq 0 ]; then
            systemctl restart "$SERVICE_NAME.service" || {
                warn "服务启动失败，最近日志："
                journalctl -u "$SERVICE_NAME.service" -n 30 --no-pager 2>/dev/null || true
                return 1
            }
        fi
    else
        rc-update add "$SERVICE_NAME" default >/dev/null 2>&1 || true
        if [ "$NO_START" -eq 0 ]; then
            rc-service "$SERVICE_NAME" restart || return 1
        fi
    fi
    return 0
}

download_to() {
    url="$1"
    dest="$2"
    if command -v curl >/dev/null 2>&1; then
        curl -fL --retry 2 --connect-timeout 10 --max-time 300 -o "$dest" "$url"
    elif command -v wget >/dev/null 2>&1; then
        wget -q --timeout=30 --tries=3 -O "$dest" "$url"
    else
        fail "未找到 curl 或 wget，无法下载二进制"
    fi
}

verify_binary() {
    file="$1"
    [ -s "$file" ] || return 1
    chmod 0755 "$file" 2>/dev/null || true
    output=$("$file" version 2>/dev/null) || return 1
    case "$output" in
        ddns-panel*) return 0 ;;
        *) return 1 ;;
    esac
}

ensure_downloader() {
    if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
        fail "未找到 curl 或 wget，请先安装其中之一，或使用 --from-file 指定本地二进制"
    fi
}

try_fetch() {
    url="$1"
    dest="$2"
    info "正在下载: $url"
    rm -f "$dest"
    download_to "$url" "$dest" 2>/dev/null && verify_binary "$dest"
}

checksum_tool() {
    if command -v sha256sum >/dev/null 2>&1; then
        printf 'sha256sum'
    elif command -v shasum >/dev/null 2>&1; then
        printf 'shasum'
    fi
}

checksum_ok() {
    file="$1"
    sums_url="$2"
    name="$3"
    tool=$(checksum_tool)
    [ -n "$tool" ] || { warn "未找到 sha256sum/shasum，跳过完整性校验"; return 0; }
    sums="$TMP_DIR/SHA256SUMS"
    rm -f "$sums"
    if ! download_to "$sums_url" "$sums" >/dev/null 2>&1; then
        info "未提供 SHA256SUMS，跳过完整性校验"
        return 0
    fi
    expected=$(awk -v n="$name" '$2==n || $2=="*"n {print tolower($1); exit}' "$sums")
    [ -n "$expected" ] || { info "SHA256SUMS 中未找到 ${name}，跳过完整性校验"; return 0; }
    if [ "$tool" = "sha256sum" ]; then
        actual=$(sha256sum "$file" | awk '{print tolower($1)}')
    else
        actual=$(shasum -a 256 "$file" | awk '{print tolower($1)}')
    fi
    [ "$actual" = "$expected" ] || return 1
    info "SHA256 校验通过"
    return 0
}

install_from_url() {
    url="$1"
    try_fetch "$url" "$FETCHED_BINARY" || return 1
    checksum_ok "$FETCHED_BINARY" "${url%/*}/SHA256SUMS" "${url##*/}" \
        || fail "SHA256 校验失败，文件可能不完整或已被篡改：$url"
    return 0
}

fetch_binary() {
    FETCHED_BINARY="$TMP_DIR/ddns"
    if [ -n "$FROM_FILE" ]; then
        [ -f "$FROM_FILE" ] || fail "本地二进制不存在: $FROM_FILE"
        cp "$FROM_FILE" "$FETCHED_BINARY" || fail "复制本地二进制失败"
        verify_binary "$FETCHED_BINARY" || fail "文件不是可用的 ddns-panel 二进制: $FROM_FILE"
        return 0
    fi

    if [ -n "${DDNS_DOWNLOAD_BASE:-}" ]; then
        primary="${DDNS_DOWNLOAD_BASE%/}/${ASSET_PREFIX}-${ARCH}"
    elif [ "$VERSION" = "latest" ]; then
        primary="https://github.com/${REPO}/releases/latest/download/${ASSET_PREFIX}-${ARCH}"
    else
        primary="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET_PREFIX}-${ARCH}"
    fi

    ensure_downloader
    if install_from_url "$primary"; then
        return 0
    fi
    case "$primary" in
        https://github.com/*) ;;
        *) fail "下载失败，请检查网络，或使用 --from-file 指定本地二进制" ;;
    esac
    if [ -n "$MIRROR_PREFIX" ]; then
        warn "官方地址不可用，尝试镜像…"
        if install_from_url "${MIRROR_PREFIX%/}/${primary}"; then
            return 0
        fi
    fi
    fail "下载失败，请检查网络，或使用 --from-file 指定本地二进制"
}

deploy_binary() {
    src="$1"
    stop_service
    mkdir -p "$(dirname "$BIN_PATH")"
    if [ -f "$BIN_PATH" ]; then
        cp -p "$BIN_PATH" "${BIN_PATH}.bak" 2>/dev/null || true
    fi
    tmp_target="${BIN_PATH}.new.$$"
    cp "$src" "$tmp_target" || fail "写入二进制失败"
    chmod 0755 "$tmp_target"
    mv -f "$tmp_target" "$BIN_PATH" || fail "替换二进制失败"
    if command -v restorecon >/dev/null 2>&1; then
        restorecon "$BIN_PATH" >/dev/null 2>&1 || true
    fi
}

write_env_file() {
    umask 077
    cat > "$ENV_FILE" <<EOF
# DDNS Master 服务环境变量
# 修改后执行: sudo systemctl restart ddns（或 rc-service ddns restart）
DDNS_ADDR=$ADDR
DDNS_DATA_DIR=$DATA_DIR
DDNS_COOKIE_SECURE=$COOKIE_SECURE
EOF
    chown root:root "$ENV_FILE" 2>/dev/null || true
    chmod 600 "$ENV_FILE" 2>/dev/null || true
}

write_systemd_unit() {
    cat > "$SYSTEMD_PATH" <<EOF
[Unit]
Description=DDNS Master - Cloudflare DDNS Panel
Documentation=https://github.com/${REPO}
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
WorkingDirectory=${DATA_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${BIN_PATH}
Restart=on-failure
RestartSec=5s
TimeoutStopSec=15s

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${DATA_DIR}
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
LockPersonality=true
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
    chmod 644 "$SYSTEMD_PATH"
}

write_openrc_service() {
    mkdir -p /var/log
    touch /var/log/ddns.log /var/log/ddns.err
    chown "$SERVICE_USER:$SERVICE_GROUP" /var/log/ddns.log /var/log/ddns.err 2>/dev/null || true
    chmod 600 /var/log/ddns.log /var/log/ddns.err 2>/dev/null || true
    cat > "$OPENRC_PATH" <<EOF
#!/sbin/openrc-run
description="DDNS Master - Cloudflare DDNS Panel"
command="${BIN_PATH}"
command_user="${SERVICE_USER}:${SERVICE_GROUP}"
command_background=true
directory="${DATA_DIR}"
pidfile="/run/ddns.pid"
output_log="/var/log/ddns.log"
error_log="/var/log/ddns.err"

if [ -r "${ENV_FILE}" ]; then
    . "${ENV_FILE}"
    export DDNS_ADDR DDNS_DATA_DIR DDNS_COOKIE_SECURE
fi

start_pre() {
    checkpath --directory --owner ${SERVICE_USER}:${SERVICE_GROUP} --mode 0700 "${DATA_DIR}"
}

depend() {
    need net
    after firewall
}
EOF
    chmod 755 "$OPENRC_PATH"
}

write_service() {
    write_env_file
    if [ "$INIT_SYSTEM" = "systemd" ]; then
        write_systemd_unit
    else
        write_openrc_service
    fi
}

primary_ip() {
    ip_addr=$(hostname -I 2>/dev/null | awk '{print $1}')
    if [ -z "$ip_addr" ] && command -v ip >/dev/null 2>&1; then
        ip_addr=$(ip -4 addr show scope global 2>/dev/null | awk '/inet /{print $2; exit}' | cut -d/ -f1)
    fi
    [ -n "$ip_addr" ] && printf '%s' "$ip_addr" || printf '服务器IP'
}

panel_url() {
    host=$(primary_ip)
    case "$ADDR" in
        :*) printf 'http://%s%s' "$host" "$ADDR" ;;
        0.0.0.0:*) printf 'http://%s:%s' "$host" "${ADDR#0.0.0.0:}" ;;
        \[*\]:*) printf 'http://%s:%s' "$host" "${ADDR##*:}" ;;
        *) printf 'http://%s' "$ADDR" ;;
    esac
}

print_summary() {
    printf '\n'
    say "DDNS Master 已就绪"
    printf '  访问地址: %s\n' "$(panel_url)"
    printf '  数据目录: %s\n' "$DATA_DIR"
    printf '  配置文件: %s\n' "$ENV_FILE"
    printf '  版本信息: %s\n' "$("$BIN_PATH" version 2>/dev/null || printf '未知')"
    if [ "$NO_START" -eq 1 ]; then
        warn "服务尚未启动（--no-start）。启动命令："
        if [ "$INIT_SYSTEM" = "systemd" ]; then
            printf '  systemctl start %s\n' "$SERVICE_NAME"
        else
            printf '  rc-service %s start\n' "$SERVICE_NAME"
        fi
    fi
    printf '\n'
}

start_after_deploy() {
    if start_service; then
        return 0
    fi
    if [ -f "${BIN_PATH}.bak" ]; then
        warn "新版启动失败，正在回滚到上一版本…"
        cp -p "${BIN_PATH}.bak" "$BIN_PATH" 2>/dev/null || true
        if start_service; then
            warn "已回滚到上一版本，请检查日志后再重试更新。"
        else
            warn "回滚后仍无法启动，请查看日志：sh install.sh logs"
        fi
    else
        warn "服务未能启动，请查看日志：sh install.sh logs"
    fi
    return 1
}

do_install() {
    detect_platform
    validate_inputs
    ensure_service_user
    prepare_data_dir
    fetch_binary
    deploy_binary "$FETCHED_BINARY"
    prepare_data_dir
    write_service
    start_after_deploy || exit 1
    print_summary
}

do_update() {
    detect_platform
    validate_inputs
    if [ ! -x "$BIN_PATH" ]; then
        fail "尚未安装 DDNS Master，请先执行：sh $0 install"
    fi
    ensure_service_user
    prepare_data_dir
    fetch_binary
    deploy_binary "$FETCHED_BINARY"
    prepare_data_dir
    write_service
    start_after_deploy || exit 1
    print_summary
}

do_uninstall() {
    detect_platform
    stop_service

    if [ "$INIT_SYSTEM" = "systemd" ]; then
        systemctl disable "$SERVICE_NAME.service" >/dev/null 2>&1 || true
        rm -f "$SYSTEMD_PATH"
        systemctl daemon-reload >/dev/null 2>&1 || true
    else
        rc-update del "$SERVICE_NAME" default >/dev/null 2>&1 || true
        rm -f "$OPENRC_PATH"
    fi

    rm -f "$BIN_PATH" "${BIN_PATH}.bak"

    purge="$PURGE"
    if [ "$purge" -eq 0 ] && [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ]; then
        printf '%s' "${YELLOW}是否同时删除面板数据库与账号？[y/N]: ${NC}"
        read -r answer || answer=""
        case "$answer" in
            y|Y|yes|YES) purge=1 ;;
            *) purge=0 ;;
        esac
    fi

    if [ "$purge" -eq 1 ]; then
        if [ -d "$DATA_DIR" ]; then
            for name in ddns_panel.db ddns_panel.db-wal ddns_panel.db-shm; do
                rm -f "$DATA_DIR/$name"
            done
        fi
        rm -f "$ENV_FILE"
        if rmdir "$DATA_DIR" 2>/dev/null; then
            info "已删除数据目录 $DATA_DIR"
        elif [ -d "$DATA_DIR" ]; then
            warn "数据目录中仍有其他文件，已保留：$DATA_DIR"
        fi
        if [ "$PKG_FAMILY" = "alpine" ]; then
            deluser "$SERVICE_USER" >/dev/null 2>&1 || true
            delgroup "$SERVICE_GROUP" >/dev/null 2>&1 || true
        else
            userdel "$SERVICE_USER" >/dev/null 2>&1 || true
            groupdel "$SERVICE_GROUP" >/dev/null 2>&1 || true
        fi
        say "服务、面板数据库与账号已删除"
    else
        say "服务已卸载，数据已保留：$DATA_DIR"
        info "重新安装后可直接沿用原有账号与域名配置。"
    fi
}

do_status() {
    detect_platform
    printf '%s\n' "${BOLD}DDNS Master 状态${NC}"
    if [ -x "$BIN_PATH" ]; then
        printf '  二进制   %s\n' "$BIN_PATH"
        printf '  版本     %s\n' "$("$BIN_PATH" version 2>/dev/null || printf '无法执行')"
    else
        printf '  二进制   未安装\n'
    fi
    printf '  数据目录 %s\n' "$DATA_DIR"
    printf '  监听地址 %s\n' "$ADDR"
    printf '  访问地址 %s\n' "$(panel_url)"
    if [ "$INIT_SYSTEM" = "systemd" ]; then
        printf '  服务状态 %s\n' "$(systemctl is-active "$SERVICE_NAME.service" 2>/dev/null || true)"
        systemctl status "$SERVICE_NAME.service" --no-pager -l 2>/dev/null | sed -n '1,12p' || true
    elif [ "$INIT_SYSTEM" = "openrc" ]; then
        rc-service "$SERVICE_NAME" status 2>/dev/null || true
    fi
}

do_logs() {
    detect_platform
    if [ "$INIT_SYSTEM" = "systemd" ]; then
        if [ -t 1 ]; then
            journalctl -u "$SERVICE_NAME.service" -n 120 --no-pager -f
        else
            journalctl -u "$SERVICE_NAME.service" -n 120 --no-pager
        fi
    else
        [ -f /var/log/ddns.log ] || fail "日志文件不存在: /var/log/ddns.log"
        files="/var/log/ddns.log"
        [ -s /var/log/ddns.err ] && files="$files /var/log/ddns.err"
        if [ -t 1 ]; then
            tail -n 120 -f $files
        else
            tail -n 120 $files
        fi
    fi
}

do_start() {
    detect_platform
    service_installed || fail "服务尚未安装，请先执行：sh $0 install"
    if [ "$INIT_SYSTEM" = "systemd" ]; then
        systemctl start "$SERVICE_NAME.service" || fail "启动失败，请执行 sh $0 logs 查看日志"
    else
        rc-service "$SERVICE_NAME" start || fail "启动失败，请执行 sh $0 logs 查看日志"
    fi
    say "服务已启动"
}

do_stop() {
    detect_platform
    stop_service
    say "服务已停止"
}

do_restart() {
    detect_platform
    service_installed || fail "服务尚未安装，请先执行：sh $0 install"
    if [ "$INIT_SYSTEM" = "systemd" ]; then
        systemctl restart "$SERVICE_NAME.service" || fail "重启失败，请执行 sh $0 logs 查看日志"
    else
        rc-service "$SERVICE_NAME" restart || fail "重启失败，请执行 sh $0 logs 查看日志"
    fi
    say "服务已重启"
}

interactive_menu() {
    [ -t 0 ] || { usage; exit 1; }
    while :; do
        printf '\n%s\n' "${BOLD}------------------------------------------${NC}"
        printf '%s\n' "${BOLD}    DDNS Master 管理脚本${NC}"
        printf '%s\n' "------------------------------------------"
        printf '  1. 安装 / 覆盖安装\n'
        printf '  2. 更新到最新版本\n'
        printf '  3. 查看状态\n'
        printf '  4. 重启服务\n'
        printf '  5. 查看日志\n'
        printf '  6. 停止服务\n'
        printf '  7. 卸载\n'
        printf '  0. 退出\n'
        printf '%s' "请选择: "
        read -r choice || exit 0
        case "$choice" in
            1) do_install; return ;;
            2) do_update; return ;;
            3) do_status; return ;;
            4) do_restart; return ;;
            5) do_logs; return ;;
            6) do_stop; return ;;
            7) do_uninstall; return ;;
            0|"") exit 0 ;;
            *) warn "无效选项" ;;
        esac
    done
}

# ---------------- main ----------------

COMMAND="menu"
case "${1:-}" in
    help|-h|--help) usage; exit 0 ;;
    install|update|uninstall|status|start|stop|restart|logs)
        COMMAND="$1"
        shift
        ;;
    "") ;;
    -* ) COMMAND="install" ;;
    *) fail "未知命令: $1（运行 sh $0 help 查看帮助）" ;;
esac

VERSION="latest"
FROM_FILE=""
PURGE=0
ASSUME_YES=0
NO_START=0
ADDR_ARG=""
DATA_DIR_ARG=""
COOKIE_ARG=""
MIRROR_PREFIX="${DDNS_MIRROR_PREFIX-https://jht126.eu.org/}"

while [ $# -gt 0 ]; do
    case "$1" in
        --version)
            [ $# -ge 2 ] || fail "--version 缺少参数"
            VERSION="$2"; shift 2 ;;
        --from-file)
            [ $# -ge 2 ] || fail "--from-file 缺少参数"
            FROM_FILE="$2"; shift 2 ;;
        --addr)
            [ $# -ge 2 ] || fail "--addr 缺少参数"
            ADDR_ARG="$2"; shift 2 ;;
        --data-dir)
            [ $# -ge 2 ] || fail "--data-dir 缺少参数"
            DATA_DIR_ARG="$2"; shift 2 ;;
        --cookie-secure)
            [ $# -ge 2 ] || fail "--cookie-secure 缺少参数"
            COOKIE_ARG="$2"; shift 2 ;;
        --yes|-y)
            ASSUME_YES=1; shift ;;
        --purge)
            PURGE=1; shift ;;
        --no-start)
            NO_START=1; shift ;;
        -h|--help)
            usage; exit 0 ;;
        *)
            fail "未知选项: $1（运行 sh $0 help 查看帮助）" ;;
    esac
done

if [ "$COMMAND" = "menu" ] && [ ! -t 0 ]; then
    usage
    exit 1
fi

require_root
load_existing_config
[ -n "$ADDR_ARG" ] && ADDR="$ADDR_ARG"
[ -n "$DATA_DIR_ARG" ] && DATA_DIR="$DATA_DIR_ARG"
[ -n "$COOKIE_ARG" ] && COOKIE_SECURE="$COOKIE_ARG"

if [ "$COMMAND" = "menu" ]; then
    detect_platform
    interactive_menu
    exit 0
fi

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/ddns-install.XXXXXX") || fail "创建临时目录失败"
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

case "$COMMAND" in
    install) do_install ;;
    update) do_update ;;
    uninstall) do_uninstall ;;
    status) do_status ;;
    start) do_start ;;
    stop) do_stop ;;
    restart) do_restart ;;
    logs) do_logs ;;
    *) usage; exit 1 ;;
esac
