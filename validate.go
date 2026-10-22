package main

import (
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

var allowedTTL = map[int]bool{1: true, 60: true, 120: true, 300: true, 600: true, 1800: true, 3600: true}

func normalizeRecordName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" {
		return "", fmt.Errorf("请输入完整域名")
	}
	if strings.Contains(name, "://") {
		u, err := url.Parse(name)
		if err == nil {
			name = u.Host
		}
	}
	if i := strings.IndexAny(name, "/?#"); i >= 0 {
		name = name[:i]
	}
	name = strings.TrimSuffix(strings.TrimSpace(name), ".")
	name = strings.ToLower(name)
	if name == "" {
		return "", fmt.Errorf("请输入完整域名")
	}
	if net.ParseIP(name) != nil {
		return "", fmt.Errorf("这里需要域名，而不是 IP 地址")
	}
	if len(name) > 253 {
		return "", fmt.Errorf("域名长度不能超过 253 个字符")
	}
	labels := strings.Split(name, ".")
	if len(labels) < 2 {
		return "", fmt.Errorf("请输入完整域名，例如 home.example.com")
	}
	for _, label := range labels {
		if label == "" {
			return "", fmt.Errorf("域名格式不正确，包含空的标签")
		}
		if len(label) > 63 {
			return "", fmt.Errorf("域名标签 %q 超过 63 个字符", label)
		}
		if label == "*" {
			continue
		}
		if label[0] == '-' || label[len(label)-1] == '-' {
			return "", fmt.Errorf("域名标签 %q 不能以连字符开头或结尾", label)
		}
		for _, r := range label {
			if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
				continue
			}
			return "", fmt.Errorf("域名包含非法字符 %q", r)
		}
	}
	return name, nil
}

func normalizeRecordType(raw string) (string, error) {
	t := strings.ToUpper(strings.TrimSpace(raw))
	if t != "A" && t != "AAAA" {
		return "", fmt.Errorf("记录类型只支持 A 或 AAAA")
	}
	return t, nil
}

func normalizeIPSource(raw string) string {
	if strings.EqualFold(strings.TrimSpace(raw), sourceInterface) {
		return sourceInterface
	}
	return sourceAPI
}

func normalizeTTL(raw string) (int, error) {
	if strings.TrimSpace(raw) == "" {
		return 1, nil
	}
	ttl, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || !allowedTTL[ttl] {
		return 0, fmt.Errorf("TTL 取值无效")
	}
	return ttl, nil
}

func validateUsername(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if n := utf8.RuneCountInString(name); n < 3 || n > 32 {
		return "", fmt.Errorf("用户名长度需为 3–32 个字符")
	}
	for _, r := range name {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return "", fmt.Errorf("用户名不能包含空格或控制字符")
		}
	}
	return name, nil
}

func validatePassword(pw string) error {
	if len(pw) < 8 {
		return fmt.Errorf("密码至少需要 8 个字符")
	}
	if len([]byte(pw)) > 72 {
		return fmt.Errorf("密码不能超过 72 字节")
	}
	return nil
}

func safeNext(raw string) string {
	if raw == "" {
		return "/"
	}
	u, err := url.Parse(raw)
	if err != nil || u.IsAbs() || u.Host != "" || !strings.HasPrefix(u.Path, "/") || strings.HasPrefix(u.Path, "//") {
		return "/"
	}
	return u.RequestURI()
}

func parsePositiveInt(raw string) (int, error) {
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || n < 1 {
		return 0, fmt.Errorf("无效的页码")
	}
	return n, nil
}
