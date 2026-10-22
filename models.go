package main

import (
	"fmt"
	"strings"
	"time"
)

const (
	StatusSynced   = "synced"
	StatusError    = "error"
	StatusPending  = "pending"
	StatusDisabled = "disabled"
)

const (
	sourceAPI       = "api"
	sourceInterface = "interface"
)

const schemaVersion = 2

type User struct {
	ID              uint `gorm:"primaryKey"`
	CreatedAt       time.Time
	UpdatedAt       time.Time
	Username        string `gorm:"size:64;uniqueIndex;not null"`
	Password        string `gorm:"not null"`
	LoginAttempts   int
	LastLoginFailed time.Time
	LockedUntil     time.Time
	LastLoginAt     time.Time
}

type Setting struct {
	ID                uint `gorm:"primaryKey"`
	CreatedAt         time.Time
	UpdatedAt         time.Time
	CFToken           string
	TelegramBotToken  string
	TelegramChatID    string
	SyncMinutes       int    `gorm:"not null;default:5"`
	SessionSecret     string `gorm:"size:128"`
	SchemaVersion     int
	LastRunAt         time.Time
	LastRunDurationMs int64
	LastRunSummary    string `gorm:"size:512"`
	LastRunFailed     int
	LastRunUpdated    int
}

type Domain struct {
	ID              uint `gorm:"primaryKey"`
	CreatedAt       time.Time
	UpdatedAt       time.Time
	ZoneID          string `gorm:"size:64;index"`
	ZoneName        string `gorm:"size:255"`
	RecordName      string `gorm:"size:255;index"`
	RecordType      string `gorm:"size:8"`
	Proxied         bool
	TTL             int
	Enabled         bool `gorm:"not null;default:true"`
	CreateIfMissing bool
	IPSource        string `gorm:"size:16"`
	InterfaceName   string `gorm:"size:64"`
	Status          string `gorm:"size:16;index"`
	LastMsg         string `gorm:"size:512"`
	LastIP          string `gorm:"size:64"`
	LastCheckAt     time.Time
	LastChangeAt    time.Time
}

func (d Domain) SourceText() string {
	if d.IPSource == sourceInterface {
		if d.InterfaceName == "" {
			return "本机网卡"
		}
		return "网卡 " + d.InterfaceName
	}
	return "自动获取公网 IP"
}

func (d Domain) StatusText() string {
	switch d.Status {
	case StatusSynced:
		return "正常"
	case StatusError:
		return "异常"
	case StatusDisabled:
		return "已停用"
	default:
		return "等待同步"
	}
}

func (d Domain) StatusTone() string {
	switch d.Status {
	case StatusSynced:
		return "success"
	case StatusError:
		return "danger"
	case StatusDisabled:
		return "muted"
	default:
		return "warning"
	}
}

func (d Domain) TypeTone() string {
	if d.RecordType == "AAAA" {
		return "violet"
	}
	return "indigo"
}

func (d Domain) TTLText() string {
	if d.Proxied || d.TTL <= 1 {
		return "自动"
	}
	return formatTTL(d.TTL)
}

func formatTTL(ttl int) string {
	switch {
	case ttl <= 1:
		return "自动"
	case ttl%3600 == 0:
		return fmt.Sprintf("%d 小时", ttl/3600)
	case ttl%60 == 0:
		return fmt.Sprintf("%d 分钟", ttl/60)
	default:
		return fmt.Sprintf("%d 秒", ttl)
	}
}

func effectiveTTL(d Domain) int {
	if d.Proxied || d.TTL <= 1 {
		return 1
	}
	return d.TTL
}

type SystemLog struct {
	ID        uint `gorm:"primaryKey"`
	CreatedAt time.Time
	Level     string `gorm:"size:16;index"`
	Message   string `gorm:"size:1024"`
}

type IPHistory struct {
	ID         uint `gorm:"primaryKey"`
	CreatedAt  time.Time
	DomainID   uint   `gorm:"index"`
	RecordName string `gorm:"size:255"`
	RecordType string `gorm:"size:8"`
	OldIP      string `gorm:"size:64"`
	NewIP      string `gorm:"size:64"`
}

func (h IPHistory) IsCreate() bool {
	return strings.TrimSpace(h.OldIP) == ""
}
