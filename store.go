package main

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"sync/atomic"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

var (
	db        *gorm.DB
	logWrites atomic.Uint64
)

func randomToken(nBytes int) string {
	buf := make([]byte, nBytes)
	if _, err := rand.Read(buf); err != nil {
		panic("系统随机数不可用: " + err.Error())
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}

func openDatabase(path string) error {
	dsn := fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)", path)
	conn, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Warn),
	})
	if err != nil {
		return fmt.Errorf("打开数据库失败: %w", err)
	}
	sqlDB, err := conn.DB()
	if err != nil {
		return fmt.Errorf("初始化数据库连接失败: %w", err)
	}
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)
	sqlDB.SetConnMaxLifetime(0)

	db = conn
	if err := db.AutoMigrate(&User{}, &Setting{}, &Domain{}, &SystemLog{}, &IPHistory{}); err != nil {
		return fmt.Errorf("数据库迁移失败: %w", err)
	}
	return nil
}

func ensureSettings() (Setting, error) {
	var s Setting
	err := db.Order("id asc").First(&s).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		s = Setting{
			SyncMinutes:   5,
			SessionSecret: randomToken(32),
			SchemaVersion: schemaVersion,
		}
		if err := db.Create(&s).Error; err != nil {
			return s, fmt.Errorf("创建设置失败: %w", err)
		}
		return s, nil
	}
	if err != nil {
		return s, fmt.Errorf("读取设置失败: %w", err)
	}

	updates := map[string]any{}
	if s.SyncMinutes < 1 || s.SyncMinutes > 1440 {
		s.SyncMinutes = 5
		updates["sync_minutes"] = 5
	}
	if s.SessionSecret == "" {
		s.SessionSecret = randomToken(32)
		updates["session_secret"] = s.SessionSecret
	}
	if s.SchemaVersion < schemaVersion {
		if err := migrateLegacySchema(); err != nil {
			return s, err
		}
		s.SchemaVersion = schemaVersion
		updates["schema_version"] = schemaVersion
	}
	if len(updates) > 0 {
		if err := db.Model(&Setting{}).Where("id = ?", s.ID).Updates(updates).Error; err != nil {
			return s, fmt.Errorf("更新设置失败: %w", err)
		}
	}
	return s, nil
}

func migrateLegacySchema() error {
	migrations := []struct {
		query string
		args  []any
	}{
		{"UPDATE domains SET status = ? WHERE status = ?", []any{StatusSynced, "Synced"}},
		{"UPDATE domains SET status = ? WHERE status = ?", []any{StatusError, "Error"}},
		{"UPDATE domains SET status = ? WHERE status = ? OR status = '' OR status IS NULL", []any{StatusPending, "Pending"}},
		{"UPDATE domains SET ip_source = ? WHERE ip_source = '' OR ip_source IS NULL", []any{sourceAPI}},
		{"UPDATE domains SET enabled = 1 WHERE enabled IS NULL", nil},
	}
	for _, m := range migrations {
		if err := db.Exec(m.query, m.args...).Error; err != nil {
			return fmt.Errorf("旧数据迁移失败: %w", err)
		}
	}
	return nil
}

func loadSetting() (Setting, error) {
	var s Setting
	if err := db.Order("id asc").First(&s).Error; err != nil {
		return s, err
	}
	return s, nil
}

func updateSetting(id uint, fields map[string]any) error {
	if len(fields) == 0 {
		return nil
	}
	return db.Model(&Setting{}).Where("id = ?", id).Updates(fields).Error
}

func addLog(level, format string, args ...any) {
	if db == nil {
		return
	}
	msg := strings.TrimSpace(fmt.Sprintf(format, args...))
	if msg == "" {
		return
	}
	if r := []rune(msg); len(r) > 1000 {
		msg = string(r[:1000]) + "…"
	}
	if err := db.Create(&SystemLog{Level: level, Message: msg}).Error; err != nil {
		log.Printf("写入日志失败: %v", err)
		return
	}
	if logWrites.Add(1)%50 == 0 {
		pruneLogs()
	}
}

func pruneLogs() {
	if err := db.Exec("DELETE FROM system_logs WHERE id NOT IN (SELECT id FROM system_logs ORDER BY id DESC LIMIT 2000)").Error; err != nil {
		log.Printf("清理日志失败: %v", err)
	}
}

func addHistory(domain Domain, oldIP, newIP string) {
	entry := IPHistory{
		DomainID:   domain.ID,
		RecordName: domain.RecordName,
		RecordType: domain.RecordType,
		OldIP:      oldIP,
		NewIP:      newIP,
	}
	if err := db.Create(&entry).Error; err != nil {
		log.Printf("写入变更记录失败: %v", err)
		return
	}
	var count int64
	db.Model(&IPHistory{}).Count(&count)
	if count > 1200 {
		db.Exec("DELETE FROM ip_histories WHERE id NOT IN (SELECT id FROM ip_histories ORDER BY id DESC LIMIT 1000)")
	}
}

func databaseSize(path string) int64 {
	var total int64
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if info, err := os.Stat(path + suffix); err == nil {
			total += info.Size()
		}
	}
	return total
}
