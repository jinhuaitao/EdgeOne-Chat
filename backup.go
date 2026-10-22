package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"gorm.io/gorm"
)

type backupSetting struct {
	CFToken          string `json:"cf_token"`
	TelegramBotToken string `json:"telegram_bot_token"`
	TelegramChatID   string `json:"telegram_chat_id"`
	SyncMinutes      int    `json:"sync_minutes"`
}

type backupDomain struct {
	RecordName      string `json:"record_name"`
	RecordType      string `json:"record_type"`
	ZoneID          string `json:"zone_id,omitempty"`
	ZoneName        string `json:"zone_name,omitempty"`
	Proxied         bool   `json:"proxied"`
	TTL             int    `json:"ttl,omitempty"`
	Enabled         *bool  `json:"enabled,omitempty"`
	CreateIfMissing bool   `json:"create_if_missing"`
	IPSource        string `json:"ip_source"`
	InterfaceName   string `json:"interface_name,omitempty"`
	LastIP          string `json:"last_ip,omitempty"`
}

type backupFile struct {
	App        string         `json:"app"`
	Format     int            `json:"format"`
	ExportedAt time.Time      `json:"exported_at"`
	Setting    backupSetting  `json:"settings"`
	Domains    []backupDomain `json:"domains"`
}

type legacyBackupFile struct {
	Setting struct {
		CFToken          string
		TelegramBotToken string
		TelegramChatID   string
	}
	Domains []struct {
		ZoneID        string
		RecordName    string
		RecordType    string
		IPSource      string
		InterfaceName string
		LastIP        string
		Proxied       bool
	}
}

const backupFormat = 2

func buildBackup() (backupFile, error) {
	setting, err := loadSetting()
	if err != nil {
		return backupFile{}, err
	}
	var domains []Domain
	if err := db.Order("id asc").Find(&domains).Error; err != nil {
		return backupFile{}, err
	}
	out := backupFile{
		App:        "ddns-panel",
		Format:     backupFormat,
		ExportedAt: time.Now(),
		Setting: backupSetting{
			CFToken:          setting.CFToken,
			TelegramBotToken: setting.TelegramBotToken,
			TelegramChatID:   setting.TelegramChatID,
			SyncMinutes:      setting.SyncMinutes,
		},
		Domains: make([]backupDomain, 0, len(domains)),
	}
	for _, d := range domains {
		enabled := d.Enabled
		out.Domains = append(out.Domains, backupDomain{
			RecordName:      d.RecordName,
			RecordType:      d.RecordType,
			ZoneID:          d.ZoneID,
			ZoneName:        d.ZoneName,
			Proxied:         d.Proxied,
			TTL:             d.TTL,
			Enabled:         &enabled,
			CreateIfMissing: d.CreateIfMissing,
			IPSource:        d.IPSource,
			InterfaceName:   d.InterfaceName,
			LastIP:          d.LastIP,
		})
	}
	return out, nil
}

func parseBackup(data []byte) (backupFile, bool, error) {
	var head map[string]json.RawMessage
	if err := json.Unmarshal(data, &head); err != nil {
		return backupFile{}, false, fmt.Errorf("备份文件不是有效的 JSON")
	}
	if raw, ok := head["app"]; ok {
		var app string
		_ = json.Unmarshal(raw, &app)
		if app == "ddns-panel" {
			var file backupFile
			if err := json.Unmarshal(data, &file); err != nil {
				return backupFile{}, false, fmt.Errorf("解析备份文件失败: %w", err)
			}
			if file.Format > backupFormat {
				return backupFile{}, false, fmt.Errorf("备份由更高版本的 DDNS Panel 生成，请先升级面板")
			}
			if _, ok := head["settings"]; !ok {
				return backupFile{}, false, fmt.Errorf("备份文件缺少 settings 字段")
			}
			return file, false, nil
		}
	}
	if _, ok := head["Setting"]; !ok {
		if _, ok := head["setting"]; !ok {
			return backupFile{}, false, fmt.Errorf("无法识别的备份格式")
		}
	}
	var legacy legacyBackupFile
	if err := json.Unmarshal(data, &legacy); err != nil {
		return backupFile{}, false, fmt.Errorf("解析旧版备份失败: %w", err)
	}
	file := backupFile{
		App:        "ddns-panel",
		Format:     1,
		ExportedAt: time.Now(),
		Setting: backupSetting{
			CFToken:          legacy.Setting.CFToken,
			TelegramBotToken: legacy.Setting.TelegramBotToken,
			TelegramChatID:   legacy.Setting.TelegramChatID,
		},
	}
	for _, d := range legacy.Domains {
		enabled := true
		file.Domains = append(file.Domains, backupDomain{
			RecordName:    d.RecordName,
			RecordType:    d.RecordType,
			ZoneID:        d.ZoneID,
			Proxied:       d.Proxied,
			Enabled:       &enabled,
			IPSource:      d.IPSource,
			InterfaceName: d.InterfaceName,
			LastIP:        d.LastIP,
		})
	}
	return file, true, nil
}

func applyBackup(file backupFile, legacy bool) (added, updated, skipped int, err error) {
	current, err := loadSetting()
	if err != nil {
		return 0, 0, 0, fmt.Errorf("读取当前设置失败: %w", err)
	}
	newToken := strings.TrimSpace(file.Setting.CFToken)
	syncMinutes := file.Setting.SyncMinutes
	if syncMinutes < 1 || syncMinutes > 1440 {
		syncMinutes = current.SyncMinutes
	}
	if syncMinutes < 1 {
		syncMinutes = 5
	}

	err = db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&Setting{}).Where("id = ?", current.ID).Updates(map[string]any{
			"cf_token":           newToken,
			"telegram_bot_token": strings.TrimSpace(file.Setting.TelegramBotToken),
			"telegram_chat_id":   strings.TrimSpace(file.Setting.TelegramChatID),
			"sync_minutes":       syncMinutes,
		}).Error; err != nil {
			return err
		}

		for _, item := range file.Domains {
			name, err := normalizeRecordName(item.RecordName)
			if err != nil {
				skipped++
				continue
			}
			recordType, err := normalizeRecordType(item.RecordType)
			if err != nil {
				skipped++
				continue
			}
			source := normalizeIPSource(item.IPSource)
			if source == sourceInterface && strings.TrimSpace(item.InterfaceName) == "" {
				skipped++
				continue
			}
			ttl := item.TTL
			if !allowedTTL[ttl] {
				ttl = 1
			}
			enabled := true
			if item.Enabled != nil {
				enabled = *item.Enabled
			}
			if legacy {
				enabled = true
			}
			status := StatusPending
			lastMsg := "配置已恢复，等待同步"
			if !enabled {
				status = StatusDisabled
				lastMsg = "已停用"
			}
			var existing Domain
			findErr := tx.Where("record_name = ? AND record_type = ?", name, recordType).First(&existing).Error
			if findErr == nil {
				if err := tx.Model(&Domain{}).Where("id = ?", existing.ID).Updates(map[string]any{
					"zone_id":           "",
					"zone_name":         "",
					"proxied":           item.Proxied,
					"ttl":               ttl,
					"enabled":           enabled,
					"create_if_missing": item.CreateIfMissing,
					"ip_source":         source,
					"interface_name":    strings.TrimSpace(item.InterfaceName),
					"status":            status,
					"last_msg":          lastMsg,
					"last_ip":           strings.TrimSpace(item.LastIP),
				}).Error; err != nil {
					return err
				}
				updated++
				continue
			}
			if findErr != nil && !errors.Is(findErr, gorm.ErrRecordNotFound) {
				return findErr
			}
			if err := tx.Create(&Domain{
				RecordName:      name,
				RecordType:      recordType,
				Proxied:         item.Proxied,
				TTL:             ttl,
				Enabled:         enabled,
				CreateIfMissing: item.CreateIfMissing,
				IPSource:        source,
				InterfaceName:   strings.TrimSpace(item.InterfaceName),
				Status:          status,
				LastMsg:         lastMsg,
				LastIP:          strings.TrimSpace(item.LastIP),
			}).Error; err != nil {
				return err
			}
			added++
		}

		if !strings.EqualFold(newToken, current.CFToken) {
			if err := tx.Model(&Domain{}).Where("enabled = ?", true).Updates(map[string]any{
				"zone_id": "", "zone_name": "", "status": StatusPending, "last_msg": "Token 已更新，等待重新检测",
			}).Error; err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return 0, 0, 0, err
	}
	return added, updated, skipped, nil
}
