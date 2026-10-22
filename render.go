package main

import (
	"embed"
	"fmt"
	"hash/fnv"
	"html/template"
	"io/fs"
	"log"
	"math"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/gin-contrib/sessions"
	"github.com/gin-gonic/gin"
)

//go:embed templates/*.html static/*
var embeddedFiles embed.FS

var (
	templateSets     map[string]*template.Template
	assetVersion     string
	faviconData      []byte
	appStart         = time.Now()
	allowedIconNames = map[string]bool{
		"dashboard": true, "globe": true, "history": true, "logs": true,
		"settings": true, "user": true, "shield": true, "logout": true,
		"menu": true, "plus": true, "refresh": true, "sun": true, "moon": true,
		"github": true, "check": true, "check-circle": true, "alert": true,
		"alert-circle": true, "clock": true, "key": true, "send": true,
		"database": true, "download": true, "upload": true, "trash": true,
		"edit": true, "cloud": true, "cloud-off": true, "activity": true,
		"chevron-left": true, "chevron-right": true, "chevron-down": true,
		"x": true, "eye": true, "eye-off": true, "info": true, "external": true,
		"bolt": true, "wifi": true, "cable": true, "arrow-right": true,
		"power": true, "spinner": true, "monitor": true, "copy": true,
		"search": true,
	}
)

type Flash struct {
	Type    string
	Message string
}

type baseData struct {
	Page            string
	Title           string
	Subtitle        string
	Theme           string
	CSRF            string
	Version         string
	AssetVersion    string
	Username        string
	Flashes         []Flash
	Now             time.Time
	IntervalMinutes int
	NextSync        time.Time
	LastRunAt       time.Time
	LastRunSummary  string
	LastRunDuration time.Duration
	LastRunFailed   int
	LastRunUpdated  int
	HasToken        bool
	HasTelegram     bool
	Running         bool
}

type authData struct {
	Page         string
	Title        string
	Theme        string
	CSRF         string
	Version      string
	AssetVersion string
	Flashes      []Flash
	Error        string
	Username     string
	Next         string
	Installed    bool
}

type errorData struct {
	Status       int
	Title        string
	Message      string
	Theme        string
	Version      string
	AssetVersion string
}

func loadTemplates() error {
	templateSets = make(map[string]*template.Template)
	pageFiles := map[string][]string{
		"dashboard": {"templates/layout.html", "templates/icons.html", "templates/dashboard.html"},
		"history":   {"templates/layout.html", "templates/icons.html", "templates/history.html"},
		"logs":      {"templates/layout.html", "templates/icons.html", "templates/logs.html"},
		"settings":  {"templates/layout.html", "templates/icons.html", "templates/settings.html"},
		"account":   {"templates/layout.html", "templates/icons.html", "templates/account.html"},
	}
	for name, files := range pageFiles {
		t, err := template.New("layout").Funcs(templateFuncs()).ParseFS(embeddedFiles, files...)
		if err != nil {
			return fmt.Errorf("解析 %s 模板失败: %w", name, err)
		}
		templateSets[name] = t
	}
	for _, name := range []string{"login", "install"} {
		t, err := template.New(name).Funcs(templateFuncs()).ParseFS(embeddedFiles, "templates/icons.html", "templates/auth.html", "templates/"+name+".html")
		if err != nil {
			return fmt.Errorf("解析 %s 模板失败: %w", name, err)
		}
		templateSets[name] = t
	}
	{
		t, err := template.New("error").Funcs(templateFuncs()).ParseFS(embeddedFiles, "templates/icons.html", "templates/error.html")
		if err != nil {
			return fmt.Errorf("解析 error 模板失败: %w", err)
		}
		templateSets["error"] = t
	}

	h := fnv.New64a()
	err := fs.WalkDir(embeddedFiles, "static", func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		data, err := fs.ReadFile(embeddedFiles, path)
		if err != nil {
			return err
		}
		_, _ = h.Write(data)
		return nil
	})
	if err != nil {
		return fmt.Errorf("读取静态资源失败: %w", err)
	}
	assetVersion = strconv.FormatUint(h.Sum64(), 36)
	faviconData, _ = fs.ReadFile(embeddedFiles, "static/favicon.svg")
	return nil
}

func templateFuncs() template.FuncMap {
	return template.FuncMap{
		"icon":      iconHTML,
		"relTime":   relTime,
		"dateTime":  formatDateTime,
		"dateOnly":  formatDate,
		"clock":     formatClock,
		"rfc3339":   func(t time.Time) string { return t.Format(time.RFC3339) },
		"countdown": countdownTarget,
		"duration":  humanDuration,
		"fileSize":  humanFileSize,
		"initial":   initialOf,
		"add":       func(a, b int) int { return a + b },
		"sub":       func(a, b int) int { return a - b },
		"dash":      dashIfZeroTime,
		"goVersion": func() string { return runtime.Version() },
		"uptime":    func() string { return humanDuration(time.Since(appStart)) },
	}
}

func iconHTML(name string, extra ...string) template.HTML {
	if !allowedIconNames[name] {
		return ""
	}
	class := "icon"
	if len(extra) > 0 && strings.TrimSpace(extra[0]) != "" {
		class += " " + strings.TrimSpace(extra[0])
	}
	return template.HTML(fmt.Sprintf(`<svg class="%s" aria-hidden="true" focusable="false"><use href="#i-%s"></use></svg>`, class, name))
}

func relTime(t time.Time) string {
	if t.IsZero() {
		return "—"
	}
	d := time.Since(t)
	future := false
	if d < 0 {
		future = true
		d = -d
	}
	var text string
	switch {
	case d < 45*time.Second:
		text = "刚刚"
	case d < 90*time.Second:
		text = "1 分钟"
	case d < time.Hour:
		text = fmt.Sprintf("%d 分钟", int(math.Round(d.Minutes())))
	case d < 36*time.Hour:
		text = fmt.Sprintf("%d 小时", int(math.Round(d.Hours())))
	case d < 30*24*time.Hour:
		text = fmt.Sprintf("%d 天", int(math.Round(d.Hours()/24)))
	default:
		return t.Format("2006-01-02 15:04")
	}
	if future {
		if text == "刚刚" {
			return "即将"
		}
		return text + "后"
	}
	if text == "刚刚" {
		return "刚刚"
	}
	return text + "前"
}

func formatDateTime(t time.Time) string {
	if t.IsZero() {
		return "—"
	}
	return t.Format("2006-01-02 15:04:05")
}

func formatDate(t time.Time) string {
	if t.IsZero() {
		return "—"
	}
	return t.Format("2006-01-02")
}

func formatClock(t time.Time) string {
	if t.IsZero() {
		return "—"
	}
	return t.Format("15:04")
}

func dashIfZeroTime(t time.Time) string {
	if t.IsZero() {
		return "—"
	}
	return t.Format("2006-01-02 15:04")
}

func humanDuration(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	if d < time.Second {
		return fmt.Sprintf("%.1f 秒", d.Seconds())
	}
	if d < time.Minute {
		return fmt.Sprintf("%d 秒", int(d.Seconds()))
	}
	if d < time.Hour {
		return fmt.Sprintf("%d 分 %d 秒", int(d.Minutes()), int(d.Seconds())%60)
	}
	return fmt.Sprintf("%d 小时 %d 分", int(d.Hours()), int(d.Minutes())%60)
}

func humanFileSize(size int64) string {
	const unit = 1024
	if size < unit {
		return fmt.Sprintf("%d B", size)
	}
	div, exp := int64(unit), 0
	for n := size / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(size)/float64(div), "KMGTPE"[exp])
}

func initialOf(username string) string {
	for _, r := range username {
		return strings.ToUpper(string(r))
	}
	return "A"
}

func newBase(c *gin.Context, page, title, subtitle string) baseData {
	setting, err := loadSetting()
	if err != nil {
		log.Printf("读取设置失败: %v", err)
	}
	interval := setting.SyncMinutes
	if interval < 1 {
		interval = 5
	}
	next := time.Time{}
	if appScheduler != nil {
		next = appScheduler.Next()
	}
	return baseData{
		Page:            page,
		Title:           title,
		Subtitle:        subtitle,
		Theme:           themeFromRequest(c),
		CSRF:            csrfToken(c),
		Version:         Version,
		AssetVersion:    assetVersion,
		Username:        sessionUser(c),
		Flashes:         takeFlashes(c),
		Now:             time.Now(),
		IntervalMinutes: interval,
		NextSync:        next,
		LastRunAt:       setting.LastRunAt,
		LastRunSummary:  setting.LastRunSummary,
		LastRunDuration: time.Duration(setting.LastRunDurationMs) * time.Millisecond,
		LastRunFailed:   setting.LastRunFailed,
		LastRunUpdated:  setting.LastRunUpdated,
		HasToken:        setting.CFToken != "",
		HasTelegram:     setting.TelegramBotToken != "" && setting.TelegramChatID != "",
		Running:         syncRunning.Load(),
	}
}

func countdownTarget(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Format(time.RFC3339)
}

func addFlash(c *gin.Context, kind, message string) {
	s := sessions.Default(c)
	s.AddFlash(kind+"\x1f"+message, "flash")
	_ = saveSession(c)
}

func takeFlashes(c *gin.Context) []Flash {
	s := sessions.Default(c)
	raw := s.Flashes("flash")
	_ = saveSession(c)
	out := make([]Flash, 0, len(raw))
	for _, item := range raw {
		text, ok := item.(string)
		if !ok {
			continue
		}
		kind, message, found := strings.Cut(text, "\x1f")
		if !found {
			kind, message = "info", text
		}
		out = append(out, Flash{Type: kind, Message: message})
	}
	return out
}

func renderPage(c *gin.Context, status int, set string, data any) {
	t, ok := templateSets[set]
	if !ok {
		c.String(500, "模板未加载")
		return
	}
	c.Header("Content-Type", "text/html; charset=utf-8")
	c.Status(status)
	if err := t.ExecuteTemplate(c.Writer, "layout.html", data); err != nil {
		log.Printf("渲染 %s 页面失败: %v", set, err)
	}
}

func renderStandalone(c *gin.Context, status int, name string, data any) {
	t, ok := templateSets[name]
	if !ok {
		c.String(500, "模板未加载")
		return
	}
	c.Header("Content-Type", "text/html; charset=utf-8")
	c.Status(status)
	if err := t.ExecuteTemplate(c.Writer, name+".html", data); err != nil {
		log.Printf("渲染 %s 页面失败: %v", name, err)
	}
}

func renderError(c *gin.Context, status int, title, message string) {
	renderStandalone(c, status, "error", errorData{
		Status:       status,
		Title:        title,
		Message:      message,
		Theme:        themeFromRequest(c),
		Version:      Version,
		AssetVersion: assetVersion,
	})
}
