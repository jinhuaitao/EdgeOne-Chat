package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"sort"
	"strings"
	"time"
)

type interfaceInfo struct {
	Name      string   `json:"name"`
	Addresses []string `json:"addresses"`
}

type ipProvider struct {
	name string
	url  string
}

var publicIPProviders = map[string][]ipProvider{
	"A": {
		{name: "ipify", url: "https://api.ipify.org"},
		{name: "icanhazip", url: "https://ipv4.icanhazip.com"},
		{name: "ip.sb", url: "https://api-ipv4.ip.sb/ip"},
	},
	"AAAA": {
		{name: "ipify", url: "https://api6.ipify.org"},
		{name: "icanhazip", url: "https://ipv6.icanhazip.com"},
		{name: "ip.sb", url: "https://api-ipv6.ip.sb/ip"},
	},
}

func listInterfaces() ([]interfaceInfo, error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	out := make([]interfaceInfo, 0, len(ifaces))
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		item := interfaceInfo{Name: iface.Name}
		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if !ok || ipNet.IP.IsLoopback() || ipNet.IP.IsLinkLocalUnicast() {
				continue
			}
			item.Addresses = append(item.Addresses, ipNet.IP.String())
		}
		sort.SliceStable(item.Addresses, func(i, j int) bool {
			ipI, ipJ := net.ParseIP(item.Addresses[i]), net.ParseIP(item.Addresses[j])
			if ipI == nil || ipJ == nil {
				return item.Addresses[i] < item.Addresses[j]
			}
			return ipI.To4() != nil && ipJ.To4() == nil
		})
		out = append(out, item)
	}
	return out, nil
}

func interfaceIP(name, recordType string) (string, error) {
	iface, err := net.InterfaceByName(name)
	if err != nil {
		return "", fmt.Errorf("网卡 %s 不存在", name)
	}
	if iface.Flags&net.FlagUp == 0 {
		return "", fmt.Errorf("网卡 %s 当前未启用", name)
	}
	addrs, err := iface.Addrs()
	if err != nil {
		return "", fmt.Errorf("读取网卡 %s 地址失败: %w", name, err)
	}
	var fallback string
	for _, addr := range addrs {
		ipNet, ok := addr.(*net.IPNet)
		if !ok || ipNet.IP.IsLoopback() || ipNet.IP.IsLinkLocalUnicast() {
			continue
		}
		ip := ipNet.IP
		if recordType == "A" {
			if v4 := ip.To4(); v4 != nil {
				if isPrivateIP(v4) && fallback == "" {
					fallback = v4.String()
					continue
				}
				return v4.String(), nil
			}
			continue
		}
		if ip.To4() != nil {
			continue
		}
		if ip.IsPrivate() {
			if fallback == "" {
				fallback = ip.String()
			}
			continue
		}
		return ip.String(), nil
	}
	if fallback != "" {
		return fallback, nil
	}
	return "", fmt.Errorf("网卡 %s 上没有可用的 %s 地址", name, familyName(recordType))
}

func fetchPublicIP(ctx context.Context, recordType string) (string, error) {
	providers := publicIPProviders[recordType]
	if len(providers) == 0 {
		return "", fmt.Errorf("不支持的记录类型 %s", recordType)
	}
	network := "tcp4"
	if recordType == "AAAA" {
		network = "tcp6"
	}
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	client := &http.Client{
		Transport: &http.Transport{
			Proxy: http.ProxyFromEnvironment,
			DialContext: func(ctx context.Context, _, addr string) (net.Conn, error) {
				return dialer.DialContext(ctx, network, addr)
			},
			TLSHandshakeTimeout:   6 * time.Second,
			ResponseHeaderTimeout: 6 * time.Second,
		},
		Timeout: 8 * time.Second,
	}
	var failures []string
	for _, p := range providers {
		reqCtx, cancel := context.WithTimeout(ctx, 6*time.Second)
		req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, p.url, nil)
		if err != nil {
			cancel()
			failures = append(failures, p.name+": 请求创建失败")
			continue
		}
		req.Header.Set("User-Agent", "ddns-panel/"+Version)
		req.Header.Set("Accept", "text/plain")
		resp, err := client.Do(req)
		if err != nil {
			cancel()
			failures = append(failures, p.name+": "+shortNetError(err))
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 128))
		resp.Body.Close()
		cancel()
		if readErr != nil {
			failures = append(failures, p.name+": 读取响应失败")
			continue
		}
		if resp.StatusCode != http.StatusOK {
			failures = append(failures, fmt.Sprintf("%s: HTTP %d", p.name, resp.StatusCode))
			continue
		}
		raw := strings.TrimSpace(string(body))
		ip := net.ParseIP(raw)
		if ip == nil || !publicIPForFamily(ip, recordType) {
			failures = append(failures, p.name+": 返回内容不是有效的公网 "+familyName(recordType))
			continue
		}
		if recordType == "A" {
			return ip.To4().String(), nil
		}
		return ip.String(), nil
	}
	return "", fmt.Errorf("无法获取公网 %s（%s）", familyName(recordType), strings.Join(failures, "；"))
}

func publicIPForFamily(ip net.IP, recordType string) bool {
	if recordType == "A" {
		ip = ip.To4()
		if ip == nil {
			return false
		}
	} else if ip.To4() != nil {
		return false
	}
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() {
		return false
	}
	return true
}

func familyName(recordType string) string {
	if recordType == "AAAA" {
		return "IPv6"
	}
	return "IPv4"
}

func isPrivateIP(ip net.IP) bool {
	return ip.IsPrivate()
}

func shortNetError(err error) string {
	msg := err.Error()
	if strings.Contains(msg, "i/o timeout") || strings.Contains(msg, "deadline exceeded") {
		return "连接超时"
	}
	if strings.Contains(msg, "no such host") {
		return "DNS 解析失败"
	}
	if strings.Contains(msg, "network is unreachable") {
		return "网络不可达"
	}
	if len(msg) > 80 {
		msg = msg[:80] + "…"
	}
	return msg
}

type ipCacheEntry struct {
	ip  string
	err error
}

func resolveDomainIP(ctx context.Context, d Domain, cache map[string]ipCacheEntry) (string, error) {
	key := d.IPSource + "|" + d.RecordType + "|" + d.InterfaceName
	if entry, ok := cache[key]; ok {
		return entry.ip, entry.err
	}
	var (
		ip  string
		err error
	)
	if d.IPSource == sourceInterface {
		ip, err = interfaceIP(d.InterfaceName, d.RecordType)
	} else {
		ip, err = fetchPublicIP(ctx, d.RecordType)
	}
	cache[key] = ipCacheEntry{ip: ip, err: err}
	return ip, err
}

func ipEqual(a, b string) bool {
	ipA, ipB := net.ParseIP(strings.TrimSpace(a)), net.ParseIP(strings.TrimSpace(b))
	if ipA != nil && ipB != nil {
		return ipA.Equal(ipB)
	}
	return strings.EqualFold(strings.TrimSpace(a), strings.TrimSpace(b))
}
