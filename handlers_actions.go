package main

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-contrib/sessions"
	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

var dummyPasswordHash = func() []byte {
	hash, _ := bcrypt.GenerateFromPassword([]byte("ddns-panel-invalid-password"), bcrypt.DefaultCost)
	return hash
}()

func handleLogin(c *gin.Context) {
	username := strings.TrimSpace(c.PostForm("username"))
	password := c.PostForm("password")
	next := safeNext(c.PostForm("next"))
	now := time.Now()

	var user User
	err := db.Where("username = ?", username).First(&user).Error
	if err != nil {
		_ = bcrypt.CompareHashAndPassword(dummyPasswordHash, []byte(password))
		renderLogin(c, http.StatusUnauthorized, "用户名或密码错误", username, next)
		return
	}

	if remaining := loginLockRemaining(user, now); remaining > 0 {
		minutes := int(remaining.Minutes()) + 1
		renderLogin(c, http.StatusTooManyRequests, fmt.Sprintf("尝试次数过多，请在 %d 分钟后重试", minutes), username, next)
		return
	}
	if user.LoginAttempts >= 5 || !user.LockedUntil.IsZero() {
		user.LoginAttempts = 0
		user.LockedUntil = time.Time{}
	}

	if bcrypt.CompareHashAndPassword([]byte(user.Password), []byte(password)) != nil {
		user.LoginAttempts++
		user.LastLoginFailed = now
		message := "用户名或密码错误"
		if user.LoginAttempts >= 5 {
			user.LockedUntil = now.Add(15 * time.Minute)
			message = "尝试次数过多，账号已锁定 15 分钟"
		} else {
			message = fmt.Sprintf("用户名或密码错误，还可尝试 %d 次", 5-user.LoginAttempts)
		}
		db.Save(&user)
		renderLogin(c, http.StatusUnauthorized, message, username, next)
		return
	}

	user.LoginAttempts = 0
	user.LastLoginFailed = time.Time{}
	user.LockedUntil = time.Time{}
	user.LastLoginAt = now
	db.Save(&user)

	s := sessions.Default(c)
	s.Clear()
	s.Set("user", user.Username)
	s.Set("csrf", randomToken(24))
	if err := saveSession(c); err != nil {
		renderLogin(c, http.StatusInternalServerError, "登录状态保存失败，请检查浏览器 Cookie 设置", username, next)
		return
	}
	c.Redirect(http.StatusFound, next)
}

func loginLockRemaining(user User, now time.Time) time.Duration {
	if !user.LockedUntil.IsZero() {
		if now.Before(user.LockedUntil) {
			return time.Until(user.LockedUntil)
		}
		return 0
	}
	if user.LoginAttempts >= 5 && !user.LastLoginFailed.IsZero() {
		until := user.LastLoginFailed.Add(15 * time.Minute)
		if now.Before(until) {
			return time.Until(until)
		}
	}
	return 0
}

func handleInstall(c *gin.Context) {
	if installed.Load() {
		c.Redirect(http.StatusFound, "/")
		return
	}
	username, err := validateUsername(c.PostForm("username"))
	if err != nil {
		renderInstall(c, http.StatusBadRequest, err.Error(), c.PostForm("username"))
		return
	}
	password := c.PostForm("password")
	if err := validatePassword(password); err != nil {
		renderInstall(c, http.StatusBadRequest, err.Error(), username)
		return
	}
	if password != c.PostForm("confirm_password") {
		renderInstall(c, http.StatusBadRequest, "两次输入的密码不一致", username)
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		renderInstall(c, http.StatusInternalServerError, "生成密码哈希失败", username)
		return
	}
	created := false
	err = db.Transaction(func(tx *gorm.DB) error {
		var count int64
		if err := tx.Model(&User{}).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return fmt.Errorf("系统已经初始化")
		}
		if err := tx.Create(&User{Username: username, Password: string(hash)}).Error; err != nil {
			return err
		}
		created = true
		return nil
	})
	if err != nil {
		renderInstall(c, http.StatusConflict, err.Error(), username)
		return
	}
	if !created {
		c.Redirect(http.StatusFound, "/login")
		return
	}
	installed.Store(true)
	s := sessions.Default(c)
	s.Clear()
	s.Set("user", username)
	s.Set("csrf", randomToken(24))
	_ = saveSession(c)
	addLog("INFO", "系统初始化完成，管理员账号: %s", username)
	addFlash(c, "success", "初始化完成，欢迎使用 DDNS Panel")
	c.Redirect(http.StatusFound, "/")
}

func renderInstall(c *gin.Context, status int, message, username string) {
	renderStandalone(c, status, "install", authData{
		Page:         "install",
		Title:        "初始化",
		Theme:        themeFromRequest(c),
		CSRF:         csrfToken(c),
		Version:      Version,
		AssetVersion: assetVersion,
		Flashes:      takeFlashes(c),
		Error:        message,
		Username:     username,
	})
}

func handleLogout(c *gin.Context) {
	s := sessions.Default(c)
	username := sessionUser(c)
	s.Clear()
	s.AddFlash("success\x1f已安全退出", "flash")
	_ = saveSession(c)
	if username != "" {
		addLog("INFO", "管理员 %s 已退出登录", username)
	}
	c.Redirect(http.StatusFound, "/login")
}

func handleUpdatePassword(c *gin.Context) {
	username := sessionUser(c)
	var user User
	if err := db.Where("username = ?", username).First(&user).Error; err != nil {
		c.Redirect(http.StatusFound, "/logout")
		return
	}
	oldPassword := c.PostForm("old_password")
	newPassword := c.PostForm("new_password")
	if bcrypt.CompareHashAndPassword([]byte(user.Password), []byte(oldPassword)) != nil {
		addFlash(c, "error", "当前密码不正确")
		c.Redirect(http.StatusFound, "/account")
		return
	}
	if err := validatePassword(newPassword); err != nil {
		addFlash(c, "error", err.Error())
		c.Redirect(http.StatusFound, "/account")
		return
	}
	if newPassword != c.PostForm("confirm_password") {
		addFlash(c, "error", "两次输入的新密码不一致")
		c.Redirect(http.StatusFound, "/account")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(user.Password), []byte(newPassword)) == nil {
		addFlash(c, "error", "新密码不能与当前密码相同")
		c.Redirect(http.StatusFound, "/account")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		addFlash(c, "error", "生成密码哈希失败")
		c.Redirect(http.StatusFound, "/account")
		return
	}
	if err := db.Model(&user).Updates(map[string]any{
		"password":          string(hash),
		"login_attempts":    0,
		"locked_until":      time.Time{},
		"last_login_failed": time.Time{},
	}).Error; err != nil {
		addFlash(c, "error", "更新密码失败: "+err.Error())
		c.Redirect(http.StatusFound, "/account")
		return
	}
	s := sessions.Default(c)
	s.Clear()
	s.AddFlash("success\x1f密码已更新，请使用新密码重新登录", "flash")
	_ = saveSession(c)
	addLog("INFO", "管理员 %s 修改了登录密码", username)
	c.Redirect(http.StatusFound, "/login")
}

func handleUpdateCloudflare(c *gin.Context) {
	setting, err := loadSetting()
	if err != nil {
		addFlash(c, "error", "读取设置失败: "+err.Error())
		c.Redirect(http.StatusFound, "/settings")
		return
	}
	token := strings.TrimSpace(c.PostForm("token"))
	if token == setting.CFToken {
		addFlash(c, "info", "Cloudflare Token 未发生变化")
		c.Redirect(http.StatusFound, "/settings")
		return
	}
	if err := updateSetting(setting.ID, map[string]any{"cf_token": token}); err != nil {
		addFlash(c, "error", "保存失败: "+err.Error())
		c.Redirect(http.StatusFound, "/settings")
		return
	}
	db.Model(&Domain{}).Where("enabled = ?", true).Updates(map[string]any{
		"zone_id": "", "zone_name": "", "status": StatusPending, "last_msg": "Token 已更新，等待重新检测",
	})
	db.Model(&Domain{}).Where("enabled = ?", false).Updates(map[string]any{
		"zone_id": "", "zone_name": "", "status": StatusDisabled, "last_msg": "已停用",
	})
	if token == "" {
		db.Model(&Domain{}).Where("enabled = ?", true).Updates(map[string]any{
			"status": StatusError, "last_msg": "尚未配置 Cloudflare API Token",
		})
		addLog("WARN", "已清除 Cloudflare API Token，自动同步暂停")
		addFlash(c, "warning", "Token 已清除，自动同步将暂停")
	} else {
		addLog("INFO", "Cloudflare API Token 已更新，等待重新检测域名")
		addFlash(c, "success", "Token 已保存，域名将在下次同步时重新检测")
		go runSync("settings")
	}
	c.Redirect(http.StatusFound, "/settings")
}

func handleUpdateTelegram(c *gin.Context) {
	setting, err := loadSetting()
	if err != nil {
		addFlash(c, "error", "读取设置失败: "+err.Error())
		c.Redirect(http.StatusFound, "/settings")
		return
	}
	token := strings.TrimSpace(c.PostForm("tg_token"))
	chatID := strings.TrimSpace(c.PostForm("tg_chat_id"))
	if err := updateSetting(setting.ID, map[string]any{
		"telegram_bot_token": token,
		"telegram_chat_id":   chatID,
	}); err != nil {
		addFlash(c, "error", "保存失败: "+err.Error())
		c.Redirect(http.StatusFound, "/settings")
		return
	}
	if token == "" || chatID == "" {
		addFlash(c, "warning", "Telegram 通知未启用：请同时填写 Bot Token 与 Chat ID")
	} else {
		addFlash(c, "success", "Telegram 通知配置已保存")
	}
	c.Redirect(http.StatusFound, "/settings")
}

func handleUpdateSchedule(c *gin.Context) {
	minutes, err := strconv.Atoi(strings.TrimSpace(c.PostForm("sync_minutes")))
	if err != nil || minutes < 1 || minutes > 1440 {
		addFlash(c, "error", "同步间隔需在 1–1440 分钟之间")
		c.Redirect(http.StatusFound, "/settings")
		return
	}
	setting, err := loadSetting()
	if err != nil {
		addFlash(c, "error", "读取设置失败: "+err.Error())
		c.Redirect(http.StatusFound, "/settings")
		return
	}
	if err := updateSetting(setting.ID, map[string]any{"sync_minutes": minutes}); err != nil {
		addFlash(c, "error", "保存失败: "+err.Error())
		c.Redirect(http.StatusFound, "/settings")
		return
	}
	if appScheduler != nil {
		appScheduler.SetInterval(time.Duration(minutes) * time.Minute)
	}
	addFlash(c, "success", fmt.Sprintf("自动同步间隔已设为 %d 分钟", minutes))
	c.Redirect(http.StatusFound, "/settings")
}

func handleClearLogs(c *gin.Context) {
	if err := db.Exec("DELETE FROM system_logs").Error; err != nil {
		addFlash(c, "error", "清空日志失败: "+err.Error())
	} else {
		addFlash(c, "success", "运行日志已清空")
	}
	c.Redirect(http.StatusFound, "/logs")
}

type domainForm struct {
	ID              uint
	RecordName      string
	RecordType      string
	IPSource        string
	InterfaceName   string
	Proxied         bool
	TTL             int
	CreateIfMissing bool
}

func parseDomainForm(c *gin.Context) (domainForm, error) {
	var f domainForm
	name, err := normalizeRecordName(c.PostForm("record_name"))
	if err != nil {
		return f, err
	}
	f.RecordName = name
	recordType, err := normalizeRecordType(c.PostForm("record_type"))
	if err != nil {
		return f, err
	}
	f.RecordType = recordType
	f.IPSource = normalizeIPSource(c.PostForm("ip_source"))
	if f.IPSource == sourceInterface {
		f.InterfaceName = strings.TrimSpace(c.PostForm("interface_name"))
		if f.InterfaceName == "" {
			return f, fmt.Errorf("请选择要读取 IP 的网卡")
		}
		ifaces, err := listInterfaces()
		if err != nil {
			return f, fmt.Errorf("读取网卡列表失败: %w", err)
		}
		found := false
		for _, iface := range ifaces {
			if iface.Name == f.InterfaceName {
				found = true
				break
			}
		}
		if !found {
			return f, fmt.Errorf("网卡 %s 不存在或未启用", f.InterfaceName)
		}
	}
	f.TTL, err = normalizeTTL(c.PostForm("ttl"))
	if err != nil {
		return f, err
	}
	f.Proxied = c.PostForm("proxied") == "on" || c.PostForm("proxied") == "true" || c.PostForm("proxied") == "1"
	f.CreateIfMissing = c.PostForm("create_if_missing") == "on" || c.PostForm("create_if_missing") == "true" || c.PostForm("create_if_missing") == "1"
	if id := c.PostForm("id"); id != "" {
		parsed, err := strconv.ParseUint(id, 10, 32)
		if err != nil || parsed == 0 {
			return f, fmt.Errorf("域名 ID 无效")
		}
		f.ID = uint(parsed)
	}
	return f, nil
}

func handleAddDomain(c *gin.Context) {
	form, err := parseDomainForm(c)
	if err != nil {
		domainFormError(c, http.StatusBadRequest, err.Error())
		return
	}
	setting, err := loadSetting()
	if err != nil || setting.CFToken == "" {
		domainFormError(c, http.StatusBadRequest, "请先在系统设置中配置 Cloudflare API Token")
		return
	}
	var duplicate int64
	db.Model(&Domain{}).Where("record_name = ? AND record_type = ?", form.RecordName, form.RecordType).Count(&duplicate)
	if duplicate > 0 {
		domainFormError(c, http.StatusConflict, "该域名与记录类型已存在，请勿重复添加")
		return
	}
	api, err := newCFClient(setting.CFToken)
	if err != nil {
		domainFormError(c, http.StatusInternalServerError, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	zoneID, zoneName, err := newZoneLookup(api).find(ctx, form.RecordName)
	if err != nil {
		domainFormError(c, http.StatusBadRequest, "无法定位 Zone: "+err.Error())
		return
	}
	domain := Domain{
		ZoneID:          zoneID,
		ZoneName:        zoneName,
		RecordName:      form.RecordName,
		RecordType:      form.RecordType,
		Proxied:         form.Proxied,
		TTL:             form.TTL,
		Enabled:         true,
		CreateIfMissing: form.CreateIfMissing,
		IPSource:        form.IPSource,
		InterfaceName:   form.InterfaceName,
		Status:          StatusPending,
		LastMsg:         "等待首次同步",
	}
	if err := db.Create(&domain).Error; err != nil {
		domainFormError(c, http.StatusInternalServerError, "保存域名失败: "+err.Error())
		return
	}
	addLog("INFO", "[%s] 已添加 %s 记录（来源: %s）", domain.RecordName, domain.RecordType, domain.SourceText())
	addFlash(c, "success", "域名已添加，正在进行首次同步")
	go runSync("domain")
	domainFormSuccess(c)
}

func handleUpdateDomain(c *gin.Context) {
	form, err := parseDomainForm(c)
	if err != nil {
		domainFormError(c, http.StatusBadRequest, err.Error())
		return
	}
	if form.ID == 0 {
		domainFormError(c, http.StatusBadRequest, "域名 ID 无效")
		return
	}
	var domain Domain
	if err := db.First(&domain, form.ID).Error; err != nil {
		domainFormError(c, http.StatusNotFound, "域名不存在或已被删除")
		return
	}
	var duplicate int64
	db.Model(&Domain{}).Where("record_name = ? AND record_type = ? AND id <> ?", form.RecordName, form.RecordType, form.ID).Count(&duplicate)
	if duplicate > 0 {
		domainFormError(c, http.StatusConflict, "该域名与记录类型已存在")
		return
	}
	updates := map[string]any{
		"record_name":       form.RecordName,
		"record_type":       form.RecordType,
		"proxied":           form.Proxied,
		"ttl":               form.TTL,
		"create_if_missing": form.CreateIfMissing,
		"ip_source":         form.IPSource,
		"interface_name":    form.InterfaceName,
		"status":            StatusPending,
		"last_msg":          "配置已修改，等待同步",
	}
	identityChanged := domain.RecordName != form.RecordName || domain.RecordType != form.RecordType
	if identityChanged {
		setting, err := loadSetting()
		if err != nil || setting.CFToken == "" {
			domainFormError(c, http.StatusBadRequest, "请先在系统设置中配置 Cloudflare API Token")
			return
		}
		api, err := newCFClient(setting.CFToken)
		if err != nil {
			domainFormError(c, http.StatusInternalServerError, err.Error())
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		zoneID, zoneName, err := newZoneLookup(api).find(ctx, form.RecordName)
		cancel()
		if err != nil {
			domainFormError(c, http.StatusBadRequest, "无法定位 Zone: "+err.Error())
			return
		}
		updates["zone_id"] = zoneID
		updates["zone_name"] = zoneName
	}
	if err := db.Model(&Domain{}).Where("id = ?", form.ID).Updates(updates).Error; err != nil {
		domainFormError(c, http.StatusInternalServerError, "保存修改失败: "+err.Error())
		return
	}
	addLog("INFO", "[%s] 域名配置已更新", form.RecordName)
	addFlash(c, "success", "域名配置已保存，正在应用变更")
	go runSync("domain")
	domainFormSuccess(c)
}

func domainFormError(c *gin.Context, status int, message string) {
	if wantsJSON(c) {
		c.JSON(status, gin.H{"ok": false, "error": message})
		return
	}
	addFlash(c, "error", message)
	c.Redirect(http.StatusFound, "/")
}

func domainFormSuccess(c *gin.Context) {
	if wantsJSON(c) {
		c.JSON(http.StatusOK, gin.H{"ok": true, "redirect": "/"})
		return
	}
	c.Redirect(http.StatusFound, "/")
}

func handleToggleDomain(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 32)
	if err != nil || id == 0 {
		addFlash(c, "error", "域名 ID 无效")
		c.Redirect(http.StatusFound, "/")
		return
	}
	var domain Domain
	if err := db.First(&domain, id).Error; err != nil {
		addFlash(c, "error", "域名不存在")
		c.Redirect(http.StatusFound, "/")
		return
	}
	enabled := !domain.Enabled
	status := StatusPending
	message := "已启用，等待同步"
	if !enabled {
		status = StatusDisabled
		message = "已停用"
	}
	if err := db.Model(&domain).Updates(map[string]any{
		"enabled": enabled, "status": status, "last_msg": message,
	}).Error; err != nil {
		addFlash(c, "error", "切换状态失败: "+err.Error())
		c.Redirect(http.StatusFound, "/")
		return
	}
	if enabled {
		addFlash(c, "success", domain.RecordName+" 已启用")
		go runSync("domain")
	} else {
		addFlash(c, "success", domain.RecordName+" 已停用，不再自动更新")
	}
	c.Redirect(http.StatusFound, "/")
}

func handleDeleteDomain(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 32)
	if err != nil || id == 0 {
		addFlash(c, "error", "域名 ID 无效")
		c.Redirect(http.StatusFound, "/")
		return
	}
	var domain Domain
	if err := db.First(&domain, id).Error; err != nil {
		addFlash(c, "error", "域名不存在")
		c.Redirect(http.StatusFound, "/")
		return
	}
	if err := db.Delete(&Domain{}, domain.ID).Error; err != nil {
		addFlash(c, "error", "删除失败: "+err.Error())
		c.Redirect(http.StatusFound, "/")
		return
	}
	addLog("WARN", "[%s] 域名已从面板移除（Cloudflare 上的记录未删除）", domain.RecordName)
	addFlash(c, "success", fmt.Sprintf("%s 已从面板移除", domain.RecordName))
	c.Redirect(http.StatusFound, "/")
}

func handleSyncAll(c *gin.Context) {
	summary := runSync("manual")
	switch {
	case summary.Busy:
		addFlash(c, "warning", "同步正在进行中，请稍后再试")
	case summary.Err != "":
		addFlash(c, "error", "同步未完成: "+summary.Err)
	default:
		addFlash(c, "success", "同步完成："+summary.FlashText())
	}
	c.Redirect(http.StatusFound, "/")
}
