package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

var (
	Version      = "dev"
	conf         appConfig
	installed    atomic.Bool
	appScheduler *scheduler
)

func main() {
	log.SetFlags(log.LstdFlags)
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "version", "-version", "--version":
			fmt.Printf("ddns-panel %s (%s)\n", Version, runtime.Version())
			return
		case "reset-admin":
			runResetAdmin(os.Args[2:])
			return
		case "help", "-h", "--help":
			printUsage()
			return
		default:
			if !strings.HasPrefix(os.Args[1], "-") {
				fmt.Fprintf(os.Stderr, "未知命令: %s\n\n", os.Args[1])
				printUsage()
				os.Exit(2)
			}
		}
	}
	flag.Parse()

	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("配置错误: %v", err)
	}
	conf = cfg
	if err := openDatabase(cfg.DBPath); err != nil {
		log.Fatalf("数据库错误: %v", err)
	}
	setting, err := ensureSettings()
	if err != nil {
		log.Fatalf("初始化失败: %v", err)
	}
	var userCount int64
	db.Model(&User{}).Count(&userCount)
	installed.Store(userCount > 0)
	pruneLogs()

	if err := loadTemplates(); err != nil {
		log.Fatalf("模板错误: %v", err)
	}
	appScheduler = newScheduler(time.Duration(setting.SyncMinutes) * time.Minute)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go appScheduler.Run(ctx)

	router := buildRouter(setting.SessionSecret)
	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	addLog("INFO", "DDNS Panel %s 已启动，监听 %s，数据目录 %s", Version, cfg.Addr, cfg.DataDir)
	log.Printf("DDNS Panel %s 已启动", Version)
	log.Printf("访问地址: http://localhost%s", displayAddr(cfg.Addr))
	log.Printf("数据目录: %s", cfg.DataDir)
	if !installed.Load() {
		log.Printf("首次使用，请打开面板完成初始化")
	}

	errCh := make(chan error, 1)
	go func() {
		errCh <- server.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("服务启动失败: %v", err)
		}
	case <-ctx.Done():
		log.Printf("正在停止服务...")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("优雅退出失败: %v", err)
		}
		select {
		case <-errCh:
		case <-time.After(2 * time.Second):
		}
		addLog("INFO", "服务已停止")
		log.Printf("服务已停止")
	}
}

func buildRouter(sessionSecret string) *gin.Engine {
	if os.Getenv("DDNS_DEBUG") == "1" {
		gin.SetMode(gin.DebugMode)
	} else {
		gin.SetMode(gin.ReleaseMode)
	}
	r := gin.New()
	r.MaxMultipartMemory = 2 << 20
	_ = r.SetTrustedProxies(nil)
	r.Use(gin.Recovery())
	r.Use(securityHeaders())
	r.Use(accessLog())

	staticRoot, err := fs.Sub(embeddedFiles, "static")
	if err != nil {
		log.Fatalf("加载静态资源失败: %v", err)
	}
	staticHandler := http.StripPrefix("/static/", http.FileServer(http.FS(staticRoot)))
	r.GET("/static/*filepath", func(c *gin.Context) {
		c.Header("Cache-Control", "public, max-age=86400")
		staticHandler.ServeHTTP(c.Writer, c.Request)
	})
	r.GET("/favicon.ico", func(c *gin.Context) {
		c.Header("Cache-Control", "public, max-age=86400")
		c.Data(http.StatusOK, "image/svg+xml", faviconData)
	})
	r.GET("/healthz", handleHealth)

	r.Use(newSessionMiddleware(sessionSecret))
	r.Use(csrfMiddleware())
	r.Use(installGuard())

	r.GET("/install", handleInstallPage)
	r.POST("/install", handleInstall)
	r.GET("/login", handleLoginPage)
	r.POST("/login", handleLogin)

	page := r.Group("/", requireAuthPage())
	page.GET("/", handleDashboard)
	page.GET("/history", handleHistory)
	page.GET("/logs", handleLogs)
	page.GET("/settings", handleSettings)
	page.GET("/account", handleAccount)
	page.POST("/logout", handleLogout)
	page.POST("/account/password", handleUpdatePassword)
	page.POST("/settings/cloudflare", handleUpdateCloudflare)
	page.POST("/settings/telegram", handleUpdateTelegram)
	page.POST("/settings/schedule", handleUpdateSchedule)
	page.POST("/settings/backup", handleBackup)
	page.POST("/settings/restore", handleRestore)
	page.POST("/sync", handleSyncAll)
	page.POST("/logs/clear", handleClearLogs)
	page.POST("/domains", handleAddDomain)
	page.POST("/domains/:id", handleUpdateDomain)
	page.POST("/domains/:id/toggle", handleToggleDomain)
	page.POST("/domains/:id/delete", handleDeleteDomain)

	api := r.Group("/api", requireAuthAPI())
	api.GET("/interfaces", handleGetInterfaces)
	api.POST("/domain/inspect", handleInspectDomain)
	api.POST("/test/cloudflare", handleTestCloudflare)
	api.POST("/test/telegram", handleTestTelegram)

	r.NoRoute(func(c *gin.Context) {
		if wantsJSON(c) {
			c.JSON(http.StatusNotFound, gin.H{"ok": false, "error": "接口不存在"})
			return
		}
		renderError(c, http.StatusNotFound, "页面不存在", "你访问的地址不存在，或已被移动。")
	})
	return r
}

func displayAddr(addr string) string {
	if strings.HasPrefix(addr, ":") {
		return addr
	}
	if strings.HasPrefix(addr, "0.0.0.0:") {
		return ":" + strings.TrimPrefix(addr, "0.0.0.0:")
	}
	return addr
}

func printUsage() {
	fmt.Print(`DDNS Panel - Cloudflare 动态域名解析面板

用法:
  ddns-panel                 启动面板
  ddns-panel version         查看版本
  ddns-panel reset-admin     重置管理员账号（生成随机密码）
  ddns-panel help            显示帮助

环境变量:
  DDNS_ADDR          监听地址，默认 :8080
  DDNS_DATA_DIR      数据目录，默认当前目录
  DDNS_COOKIE_SECURE auto|true|false，默认 auto
  DDNS_DEBUG=1       开启 Gin 调试模式
`)
}

func runResetAdmin(args []string) {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("配置错误: %v", err)
	}
	if err := openDatabase(cfg.DBPath); err != nil {
		log.Fatalf("数据库错误: %v", err)
	}
	if _, err := ensureSettings(); err != nil {
		log.Fatalf("初始化失败: %v", err)
	}
	username := ""
	if len(args) > 0 {
		username = strings.TrimSpace(args[0])
	}
	if username == "" {
		var first User
		if err := db.Order("id asc").First(&first).Error; err == nil {
			username = first.Username
		} else {
			username = "admin"
		}
	} else {
		var err error
		username, err = validateUsername(username)
		if err != nil {
			log.Fatalf("用户名无效: %v", err)
		}
	}
	password := randomToken(12)
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		log.Fatalf("生成密码失败: %v", err)
	}
	var user User
	err = db.Order("id asc").First(&user).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		user = User{Username: username, Password: string(hash)}
		if err := db.Create(&user).Error; err != nil {
			log.Fatalf("创建管理员失败: %v", err)
		}
	} else if err != nil {
		log.Fatalf("读取管理员失败: %v", err)
	} else {
		var conflict int64
		db.Model(&User{}).Where("username = ? AND id <> ?", username, user.ID).Count(&conflict)
		if conflict > 0 {
			log.Fatalf("用户名 %s 已被占用", username)
		}
		if err := db.Model(&User{}).Where("id = ?", user.ID).Updates(map[string]any{
			"username":          username,
			"password":          string(hash),
			"login_attempts":    0,
			"locked_until":      time.Time{},
			"last_login_failed": time.Time{},
		}).Error; err != nil {
			log.Fatalf("重置管理员失败: %v", err)
		}
	}
	fmt.Println("管理员账号已重置")
	fmt.Printf("用户名: %s\n", username)
	fmt.Printf("密码:   %s\n", password)
	fmt.Println("请登录后立即前往“账号安全”修改密码。")
}
