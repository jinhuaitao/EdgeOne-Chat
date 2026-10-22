package main

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

type dashboardStats struct {
	Total    int
	Enabled  int
	Synced   int
	Errors   int
	Pending  int
	Disabled int
}

type dashboardData struct {
	baseData
	Domains []Domain
	Stats   dashboardStats
	Recent  []IPHistory
}

type settingsView struct {
	CFToken          string
	TelegramBotToken string
	TelegramChatID   string
	SyncMinutes      int
}

type settingsData struct {
	baseData
	Setting      settingsView
	DataDir      string
	DBPath       string
	DBSize       int64
	DomainCount  int64
	EnabledCount int64
}

type logsData struct {
	baseData
	Logs  []SystemLog
	Level string
	Query string
	Total int64
	Limit int
	Shown int
}

type historyData struct {
	baseData
	Rows        []IPHistory
	CurrentPage int
	TotalPages  int
	Total       int64
}

type accountData struct {
	baseData
	User User
}

func handleDashboard(c *gin.Context) {
	data := dashboardData{baseData: newBase(c, "dashboard", "概览", "实时掌握域名解析与同步状态")}
	if err := db.Order("id asc").Find(&data.Domains).Error; err != nil {
		addLog("ERROR", "读取域名列表失败: %v", err)
	}
	db.Order("created_at desc, id desc").Limit(8).Find(&data.Recent)
	data.Stats.Total = len(data.Domains)
	for _, d := range data.Domains {
		if d.Enabled {
			data.Stats.Enabled++
		}
		switch d.Status {
		case StatusSynced:
			data.Stats.Synced++
		case StatusError:
			data.Stats.Errors++
		case StatusDisabled:
			data.Stats.Disabled++
		default:
			data.Stats.Pending++
		}
	}
	renderPage(c, http.StatusOK, "dashboard", data)
}

func handleSettings(c *gin.Context) {
	data := settingsData{baseData: newBase(c, "settings", "系统设置", "连接 Cloudflare、配置通知与自动同步")}
	setting, err := loadSetting()
	if err != nil {
		addFlash(c, "error", "读取设置失败: "+err.Error())
		c.Redirect(http.StatusFound, "/")
		return
	}
	data.Setting = settingsView{
		CFToken:          setting.CFToken,
		TelegramBotToken: setting.TelegramBotToken,
		TelegramChatID:   setting.TelegramChatID,
		SyncMinutes:      setting.SyncMinutes,
	}
	data.DataDir = conf.DataDir
	data.DBPath = conf.DBPath
	data.DBSize = databaseSize(conf.DBPath)
	db.Model(&Domain{}).Count(&data.DomainCount)
	db.Model(&Domain{}).Where("enabled = ?", true).Count(&data.EnabledCount)
	renderPage(c, http.StatusOK, "settings", data)
}

func handleLogs(c *gin.Context) {
	level := strings.ToUpper(strings.TrimSpace(c.Query("level")))
	switch level {
	case "INFO", "SUCCESS", "WARN", "ERROR":
	default:
		level = ""
	}
	query := strings.TrimSpace(c.Query("q"))
	if len([]rune(query)) > 100 {
		query = string([]rune(query)[:100])
	}
	data := logsData{
		baseData: newBase(c, "logs", "运行日志", "排查同步结果与异常原因"),
		Level:    level,
		Query:    query,
		Limit:    300,
	}
	q := db.Model(&SystemLog{})
	if level != "" {
		q = q.Where("level = ?", level)
	}
	if query != "" {
		q = q.Where("message LIKE ? ESCAPE '\\'", "%"+escapeLike(query)+"%")
	}
	q.Count(&data.Total)
	if err := q.Order("id desc").Limit(data.Limit).Find(&data.Logs).Error; err != nil {
		addLog("ERROR", "读取日志失败: %v", err)
	}
	data.Shown = len(data.Logs)
	renderPage(c, http.StatusOK, "logs", data)
}

func handleHistory(c *gin.Context) {
	const perPage = 25
	page := 1
	if raw := c.Query("page"); raw != "" {
		if parsed, err := parsePositiveInt(raw); err == nil {
			page = parsed
		}
	}
	data := historyData{baseData: newBase(c, "history", "变更历史", "每一次 IP 更新都有迹可循")}
	db.Model(&IPHistory{}).Count(&data.Total)
	data.TotalPages = int((data.Total + perPage - 1) / perPage)
	if data.TotalPages == 0 {
		data.TotalPages = 1
	}
	if page > data.TotalPages {
		page = data.TotalPages
	}
	data.CurrentPage = page
	db.Order("id desc").Offset((page - 1) * perPage).Limit(perPage).Find(&data.Rows)
	renderPage(c, http.StatusOK, "history", data)
}

func handleAccount(c *gin.Context) {
	data := accountData{baseData: newBase(c, "account", "账号安全", "管理登录凭据与会话安全")}
	if err := db.Where("username = ?", data.Username).First(&data.User).Error; err != nil {
		addFlash(c, "error", "用户不存在，请重新登录")
		c.Redirect(http.StatusFound, "/logout")
		return
	}
	renderPage(c, http.StatusOK, "account", data)
}

func handleLoginPage(c *gin.Context) {
	if sessionUser(c) != "" {
		c.Redirect(http.StatusFound, "/")
		return
	}
	renderLogin(c, http.StatusOK, "", "", safeNext(c.Query("next")))
}

func handleInstallPage(c *gin.Context) {
	renderStandalone(c, http.StatusOK, "install", authData{
		Page:         "install",
		Title:        "初始化",
		Theme:        themeFromRequest(c),
		CSRF:         csrfToken(c),
		Version:      Version,
		AssetVersion: assetVersion,
		Flashes:      takeFlashes(c),
	})
}

func renderLogin(c *gin.Context, status int, message, username, next string) {
	renderStandalone(c, status, "login", authData{
		Page:         "login",
		Title:        "登录",
		Theme:        themeFromRequest(c),
		CSRF:         csrfToken(c),
		Version:      Version,
		AssetVersion: assetVersion,
		Flashes:      takeFlashes(c),
		Error:        message,
		Username:     username,
		Next:         next,
	})
}

func escapeLike(s string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return replacer.Replace(s)
}
