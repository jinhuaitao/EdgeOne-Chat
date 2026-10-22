package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type appConfig struct {
	Addr         string
	DataDir      string
	DBPath       string
	CookieSecure string
}

func loadConfig() (appConfig, error) {
	cfg := appConfig{
		Addr:         strings.TrimSpace(os.Getenv("DDNS_ADDR")),
		DataDir:      strings.TrimSpace(os.Getenv("DDNS_DATA_DIR")),
		CookieSecure: strings.ToLower(strings.TrimSpace(os.Getenv("DDNS_COOKIE_SECURE"))),
	}
	if cfg.Addr == "" {
		cfg.Addr = ":8080"
	}
	if cfg.DataDir == "" {
		cfg.DataDir = "."
	}
	absDir, err := filepath.Abs(cfg.DataDir)
	if err != nil {
		return cfg, fmt.Errorf("解析数据目录失败: %w", err)
	}
	cfg.DataDir = absDir
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		return cfg, fmt.Errorf("创建数据目录 %s 失败: %w", cfg.DataDir, err)
	}
	cfg.DBPath = filepath.Join(cfg.DataDir, "ddns_panel.db")
	switch cfg.CookieSecure {
	case "", "auto", "true", "false":
	default:
		return cfg, fmt.Errorf("DDNS_COOKIE_SECURE 只能是 auto、true 或 false")
	}
	return cfg, nil
}
