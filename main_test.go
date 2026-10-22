package main

import (
	"net"
	"strings"
	"testing"
)

func TestNormalizeRecordName(t *testing.T) {
	valid := map[string]string{
		" Example.COM. ":                    "example.com",
		"https://Home.Example.com/path?q=1": "home.example.com",
		"*.example.com":                     "*.example.com",
		"foo_bar.example.com":               "foo_bar.example.com",
		"home.example.com.":                 "home.example.com",
	}
	for input, want := range valid {
		got, err := normalizeRecordName(input)
		if err != nil {
			t.Fatalf("normalizeRecordName(%q) 返回错误: %v", input, err)
		}
		if got != want {
			t.Fatalf("normalizeRecordName(%q) = %q, want %q", input, got, want)
		}
	}

	invalid := []string{
		"",
		"localhost",
		"127.0.0.1",
		"-bad.example.com",
		"bad-.example.com",
		"a..example.com",
		"bad label.example.com",
		"例子.com",
		strings.Repeat("a", 64) + ".example.com",
		strings.Repeat("a.", 130) + "com",
	}
	for _, input := range invalid {
		if _, err := normalizeRecordName(input); err == nil {
			t.Fatalf("normalizeRecordName(%q) 应返回错误", input)
		}
	}
}

func TestNormalizeRecordTypeAndSource(t *testing.T) {
	if got, err := normalizeRecordType(" aaaa "); err != nil || got != "AAAA" {
		t.Fatalf("AAAA 解析失败: %q %v", got, err)
	}
	if _, err := normalizeRecordType("CNAME"); err == nil {
		t.Fatal("CNAME 应被拒绝")
	}
	if got := normalizeIPSource(" INTERFACE "); got != sourceInterface {
		t.Fatalf("来源 = %q, want %q", got, sourceInterface)
	}
	if got := normalizeIPSource("something"); got != sourceAPI {
		t.Fatalf("未知来源应回退到 API，得到 %q", got)
	}
}

func TestNormalizeTTL(t *testing.T) {
	cases := map[string]int{"": 1, "1": 1, "60": 60, "3600": 3600}
	for input, want := range cases {
		got, err := normalizeTTL(input)
		if err != nil || got != want {
			t.Fatalf("normalizeTTL(%q) = %d, %v; want %d", input, got, err, want)
		}
	}
	for _, input := range []string{"2", "0", "-1", "abc"} {
		if _, err := normalizeTTL(input); err == nil {
			t.Fatalf("normalizeTTL(%q) 应返回错误", input)
		}
	}
}

func TestValidateCredentials(t *testing.T) {
	if _, err := validateUsername(" admin "); err != nil {
		t.Fatalf("合法用户名被拒绝: %v", err)
	}
	for _, name := range []string{"ab", strings.Repeat("a", 33), "a b", "a\tb"} {
		if _, err := validateUsername(name); err == nil {
			t.Fatalf("用户名 %q 应被拒绝", name)
		}
	}
	if err := validatePassword("12345678"); err != nil {
		t.Fatalf("合法密码被拒绝: %v", err)
	}
	if err := validatePassword("1234567"); err == nil {
		t.Fatal("过短密码应被拒绝")
	}
	if err := validatePassword(strings.Repeat("密", 25)); err == nil {
		t.Fatal("超过 72 字节的密码应被拒绝")
	}
}

func TestSafeNext(t *testing.T) {
	cases := map[string]string{
		"":                    "/",
		"/history?page=2":     "/history?page=2",
		"https://evil.com/x":  "/",
		"//evil.com/x":        "/",
		"javascript:alert(1)": "/",
		"history":             "/",
		"/path#section":       "/path",
	}
	for input, want := range cases {
		if got := safeNext(input); got != want {
			t.Fatalf("safeNext(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestParsePositiveInt(t *testing.T) {
	if n, err := parsePositiveInt(" 7 "); err != nil || n != 7 {
		t.Fatalf("parsePositiveInt = %d, %v", n, err)
	}
	for _, input := range []string{"0", "-3", "x", ""} {
		if _, err := parsePositiveInt(input); err == nil {
			t.Fatalf("parsePositiveInt(%q) 应返回错误", input)
		}
	}
}

func TestTTLHelpers(t *testing.T) {
	if got := effectiveTTL(Domain{TTL: 300}); got != 300 {
		t.Fatalf("effectiveTTL = %d, want 300", got)
	}
	if got := effectiveTTL(Domain{TTL: 300, Proxied: true}); got != 1 {
		t.Fatalf("代理记录应使用自动 TTL，得到 %d", got)
	}
	if got := formatTTL(3600); got != "1 小时" {
		t.Fatalf("formatTTL(3600) = %q", got)
	}
	if got := formatTTL(120); got != "2 分钟" {
		t.Fatalf("formatTTL(120) = %q", got)
	}
	if got := (Domain{TTL: 1}).TTLText(); got != "自动" {
		t.Fatalf("TTLText = %q", got)
	}
}

func TestIPHelpers(t *testing.T) {
	if !ipEqual("2001:db8::1", "2001:0DB8:0:0:0:0:0:1") {
		t.Fatal("等价 IPv6 应判定相等")
	}
	if !ipEqual("203.0.113.1", " 203.0.113.1 ") {
		t.Fatal("去除空格后的 IPv4 应判定相等")
	}
	if ipEqual("203.0.113.1", "203.0.113.2") {
		t.Fatal("不同 IP 不应判定相等")
	}
	if !publicIPForFamily(net.ParseIP("8.8.8.8"), "A") {
		t.Fatal("8.8.8.8 应是有效的 A 记录地址")
	}
	if publicIPForFamily(net.ParseIP("8.8.8.8"), "AAAA") {
		t.Fatal("IPv4 不应通过 AAAA 校验")
	}
	if publicIPForFamily(net.ParseIP("192.168.1.1"), "A") {
		t.Fatal("内网地址不应通过公网校验")
	}
	if !publicIPForFamily(net.ParseIP("2606:4700:4700::1111"), "AAAA") {
		t.Fatal("公网 IPv6 应通过校验")
	}
	if publicIPForFamily(net.ParseIP("fe80::1"), "AAAA") {
		t.Fatal("链路本地地址不应通过公网校验")
	}
}

func TestParseBackupV2(t *testing.T) {
	data := []byte(`{
		"app":"ddns-panel",
		"format":2,
		"settings":{"cf_token":"cf-token","telegram_bot_token":"tg","telegram_chat_id":"1","sync_minutes":10},
		"domains":[{"record_name":"home.example.com","record_type":"A","ip_source":"api","enabled":false,"ttl":300}]
	}`)
	file, legacy, err := parseBackup(data)
	if err != nil {
		t.Fatalf("解析 v2 备份失败: %v", err)
	}
	if legacy {
		t.Fatal("v2 备份不应被识别为旧格式")
	}
	if file.Format != 2 || file.Setting.CFToken != "cf-token" || len(file.Domains) != 1 {
		t.Fatalf("v2 备份内容不正确: %+v", file)
	}
	if file.Domains[0].Enabled == nil || *file.Domains[0].Enabled {
		t.Fatal("应保留停用状态")
	}
}

func TestParseBackupErrors(t *testing.T) {
	cases := []string{
		`not json`,
		`{"app":"ddns-panel","format":99,"settings":{}}`,
		`{"app":"ddns-panel","format":2,"domains":[]}`,
		`{"nothing":true}`,
	}
	for _, input := range cases {
		if _, _, err := parseBackup([]byte(input)); err == nil {
			t.Fatalf("parseBackup(%q) 应返回错误", input)
		}
	}
}

func TestParseLegacyBackup(t *testing.T) {
	data := []byte(`{
		"Setting":{"CFToken":"old-token","TelegramBotToken":"","TelegramChatID":""},
		"Domains":[{"RecordName":"legacy.example.com","RecordType":"AAAA","IPSource":"interface","InterfaceName":"eth0","LastIP":"2001:db8::1"}]
	}`)
	file, legacy, err := parseBackup(data)
	if err != nil {
		t.Fatalf("解析旧版备份失败: %v", err)
	}
	if !legacy || file.Format != 1 || len(file.Domains) != 1 {
		t.Fatalf("旧版备份识别不正确: legacy=%v file=%+v", legacy, file)
	}
	if file.Domains[0].Enabled == nil || !*file.Domains[0].Enabled {
		t.Fatal("旧版域名默认应为启用状态")
	}
}

func TestLoadConfig(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DDNS_ADDR", "")
	t.Setenv("DDNS_DATA_DIR", dir)
	t.Setenv("DDNS_COOKIE_SECURE", "auto")
	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig 失败: %v", err)
	}
	if cfg.Addr != ":8080" || cfg.DataDir != dir || !strings.HasSuffix(cfg.DBPath, "ddns_panel.db") {
		t.Fatalf("配置不正确: %+v", cfg)
	}

	t.Setenv("DDNS_COOKIE_SECURE", "sometimes")
	if _, err := loadConfig(); err == nil {
		t.Fatal("非法 DDNS_COOKIE_SECURE 应返回错误")
	}
}
