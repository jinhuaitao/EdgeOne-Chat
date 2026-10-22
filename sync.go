package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/cloudflare/cloudflare-go"
)

var (
	runMu        sync.Mutex
	syncRunning  atomic.Bool
	errSyncBusy  = errors.New("同步正在进行中")
	runStartedAt time.Time
)

type syncSummary struct {
	Started time.Time
	Elapsed time.Duration
	Checked int
	Updated int
	Created int
	Failed  int
	Skipped int
	Busy    bool
	Err     string
}

func (s syncSummary) SummaryText() string {
	if s.Err != "" {
		return s.Err
	}
	if s.Checked == 0 {
		return "没有启用的域名"
	}
	parts := []string{fmt.Sprintf("检查 %d", s.Checked)}
	if s.Updated > 0 {
		parts = append(parts, fmt.Sprintf("更新 %d", s.Updated))
	}
	if s.Created > 0 {
		parts = append(parts, fmt.Sprintf("新建 %d", s.Created))
	}
	if s.Failed > 0 {
		parts = append(parts, fmt.Sprintf("失败 %d", s.Failed))
	}
	if s.Updated == 0 && s.Created == 0 && s.Failed == 0 {
		return fmt.Sprintf("检查 %d，全部已是最新", s.Checked)
	}
	return strings.Join(parts, " · ")
}

func (s syncSummary) FlashText() string {
	if s.Err != "" {
		return s.Err
	}
	return s.SummaryText() + "（" + humanDuration(s.Elapsed) + "）"
}

func runSync(trigger string) syncSummary {
	started := time.Now()
	summary := syncSummary{Started: started}
	if !runMu.TryLock() {
		summary.Busy = true
		summary.Err = errSyncBusy.Error()
		return summary
	}
	syncRunning.Store(true)
	runStartedAt = started
	defer func() {
		syncRunning.Store(false)
		runMu.Unlock()
	}()

	setting, err := loadSetting()
	if err != nil {
		summary.Err = "读取设置失败: " + err.Error()
		return summary
	}
	var domains []Domain
	if err := db.Order("id asc").Find(&domains).Error; err != nil {
		summary.Err = "读取域名列表失败: " + err.Error()
		return summary
	}
	if setting.CFToken == "" {
		summary.Err = "尚未配置 Cloudflare API Token"
		summary.Elapsed = time.Since(started)
		persistRun(setting, summary)
		if trigger == "manual" {
			addLog("WARN", "手动同步未执行: 尚未配置 Cloudflare API Token")
		}
		return summary
	}
	if len(domains) == 0 {
		summary.Elapsed = time.Since(started)
		persistRun(setting, summary)
		if trigger == "manual" {
			addLog("INFO", "手动同步完成: 暂无托管域名")
		}
		return summary
	}

	api, err := newCFClient(setting.CFToken)
	if err != nil {
		summary.Err = err.Error()
		summary.Elapsed = time.Since(started)
		persistRun(setting, summary)
		addLog("ERROR", "同步未执行: %v", err)
		return summary
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	lookup := newZoneLookup(api)
	cache := make(map[string]ipCacheEntry)
	var events []notifyEvent

	for i := range domains {
		d := &domains[i]
		if !d.Enabled {
			summary.Skipped++
			continue
		}
		summary.Checked++
		outcome := syncOne(ctx, api, lookup, d, cache)
		if outcome.err != nil {
			summary.Failed++
			continue
		}
		if outcome.created {
			summary.Created++
		} else if outcome.changed {
			summary.Updated++
		}
		if outcome.event != nil {
			events = append(events, *outcome.event)
		}
	}

	summary.Elapsed = time.Since(started)
	persistRun(setting, summary)
	if trigger == "manual" || summary.Failed > 0 {
		level := "INFO"
		if summary.Failed > 0 {
			level = "WARN"
		} else if summary.Created+summary.Updated > 0 {
			level = "SUCCESS"
		}
		addLog(level, "%s：%s（%s）", triggerLabel(trigger), summary.SummaryText(), humanDuration(summary.Elapsed))
	}
	dispatchNotifications(setting, events)
	return summary
}

func triggerLabel(trigger string) string {
	switch trigger {
	case "manual":
		return "手动同步完成"
	case "scheduled":
		return "定时同步完成"
	case "restore":
		return "恢复后同步完成"
	case "domain":
		return "新增/修改域名后同步完成"
	default:
		return "同步完成"
	}
}

func persistRun(setting Setting, summary syncSummary) {
	if setting.ID == 0 {
		return
	}
	if err := updateSetting(setting.ID, map[string]any{
		"last_run_at":          summary.Started,
		"last_run_duration_ms": summary.Elapsed.Milliseconds(),
		"last_run_summary":     truncateText(summary.SummaryText(), 500),
		"last_run_failed":      summary.Failed,
		"last_run_updated":     summary.Updated + summary.Created,
	}); err != nil {
		addLog("WARN", "保存运行状态失败: %v", err)
	}
}

type syncOutcome struct {
	changed  bool
	created  bool
	event    *notifyEvent
	recovery bool
	err      error
}

func syncOne(ctx context.Context, api *cloudflare.API, lookup *zoneLookup, d *Domain, cache map[string]ipCacheEntry) syncOutcome {
	now := time.Now()
	ip, err := resolveDomainIP(ctx, *d, cache)
	if err != nil {
		return syncFailure(d, "IP 获取失败: "+truncateText(err.Error(), 320))
	}

	if d.ZoneID == "" {
		zoneID, zoneName, err := lookup.find(ctx, d.RecordName)
		if err != nil {
			return syncFailure(d, "定位 Zone 失败: "+truncateText(err.Error(), 320))
		}
		d.ZoneID, d.ZoneName = zoneID, zoneName
	}

	records, _, err := api.ListDNSRecords(ctx, cloudflare.ZoneIdentifier(d.ZoneID), cloudflare.ListDNSRecordsParams{
		Name: d.RecordName,
		Type: d.RecordType,
	})
	if err != nil {
		return syncFailure(d, "查询 DNS 记录失败: "+describeCFError(err))
	}
	if len(records) > 1 {
		return syncFailure(d, fmt.Sprintf("Cloudflare 上存在 %d 条同名 %s 记录，请先清理重复记录", len(records), d.RecordType))
	}
	if len(records) == 0 {
		if !d.CreateIfMissing {
			return syncFailure(d, fmt.Sprintf("Cloudflare 上不存在该 %s 记录，可在编辑中开启“自动创建记录”", d.RecordType))
		}
		ttl := effectiveTTL(*d)
		if _, err := api.CreateDNSRecord(ctx, cloudflare.ZoneIdentifier(d.ZoneID), cloudflare.CreateDNSRecordParams{
			Type:    d.RecordType,
			Name:    d.RecordName,
			Content: ip,
			Proxied: &d.Proxied,
			TTL:     ttl,
		}); err != nil {
			return syncFailure(d, "创建 DNS 记录失败: "+describeCFError(err))
		}
		wasError := d.Status == StatusError
		d.Status = StatusSynced
		d.LastIP = ip
		d.LastMsg = "记录已创建"
		d.LastCheckAt = now
		d.LastChangeAt = now
		saveDomainSync(d)
		addHistory(*d, "", ip)
		addLog("SUCCESS", "[%s] 已创建 %s 记录 → %s", d.RecordName, d.RecordType, ip)
		if wasError {
			addLog("INFO", "[%s] 已恢复正常", d.RecordName)
		}
		return syncOutcome{
			changed: true,
			created: true,
			event:   &notifyEvent{Domain: *d, NewIP: ip, Created: true},
		}
	}

	record := records[0]
	recordProxied := record.Proxied != nil && *record.Proxied
	contentChanged := !ipEqual(record.Content, ip)
	proxiedChanged := recordProxied != d.Proxied
	ttl := effectiveTTL(*d)
	ttlChanged := record.TTL > 0 && record.TTL != ttl

	if !contentChanged && !proxiedChanged && !ttlChanged {
		recovered := d.Status == StatusError
		d.Status = StatusSynced
		d.LastIP = ip
		d.LastMsg = "已是最新"
		d.LastCheckAt = now
		saveDomainSync(d)
		if recovered {
			addLog("INFO", "[%s] 已恢复正常", d.RecordName)
		}
		return syncOutcome{recovery: recovered}
	}

	_, err = api.UpdateDNSRecord(ctx, cloudflare.ZoneIdentifier(d.ZoneID), cloudflare.UpdateDNSRecordParams{
		ID:      record.ID,
		Type:    d.RecordType,
		Name:    d.RecordName,
		Content: ip,
		Proxied: &d.Proxied,
		TTL:     ttl,
		Tags:    record.Tags,
	})
	if err != nil {
		return syncFailure(d, "更新 DNS 记录失败: "+describeCFError(err))
	}

	oldIP := record.Content
	wasError := d.Status == StatusError
	d.Status = StatusSynced
	d.LastIP = ip
	d.LastCheckAt = now
	d.LastChangeAt = now
	if contentChanged {
		d.LastMsg = "同步成功"
	} else {
		d.LastMsg = "配置已更新"
	}
	saveDomainSync(d)

	if contentChanged {
		addHistory(*d, oldIP, ip)
		addLog("SUCCESS", "[%s] IP 更新成功: %s → %s", d.RecordName, oldIP, ip)
		if wasError {
			addLog("INFO", "[%s] 已恢复正常", d.RecordName)
		}
		return syncOutcome{
			changed: true,
			event:   &notifyEvent{Domain: *d, OldIP: oldIP, NewIP: ip},
		}
	}

	var changes []string
	if proxiedChanged {
		if d.Proxied {
			changes = append(changes, "已开启 CDN 代理")
		} else {
			changes = append(changes, "已关闭 CDN 代理")
		}
	}
	if ttlChanged {
		changes = append(changes, "TTL 已更新为 "+formatTTL(ttl))
	}
	addLog("INFO", "[%s] %s", d.RecordName, strings.Join(changes, "，"))
	if wasError {
		addLog("INFO", "[%s] 已恢复正常", d.RecordName)
	}
	return syncOutcome{changed: true}
}

func syncFailure(d *Domain, msg string) syncOutcome {
	msg = truncateText(msg, 500)
	now := time.Now()
	wasError := d.Status == StatusError
	messageChanged := d.LastMsg != msg
	d.Status = StatusError
	d.LastMsg = msg
	d.LastCheckAt = now
	saveDomainSync(d)
	if !wasError || messageChanged {
		addLog("ERROR", "[%s] %s", d.RecordName, msg)
	}
	return syncOutcome{err: errors.New(msg)}
}

func saveDomainSync(d *Domain) {
	err := db.Model(&Domain{}).Where("id = ?", d.ID).Updates(map[string]any{
		"zone_id":        d.ZoneID,
		"zone_name":      d.ZoneName,
		"status":         d.Status,
		"last_msg":       d.LastMsg,
		"last_ip":        d.LastIP,
		"last_check_at":  d.LastCheckAt,
		"last_change_at": d.LastChangeAt,
	}).Error
	if err != nil {
		addLog("ERROR", "[%s] 保存同步状态失败: %v", d.RecordName, err)
	}
}
