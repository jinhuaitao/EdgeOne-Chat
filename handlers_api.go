package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

func handleGetInterfaces(c *gin.Context) {
	ifaces, err := listInterfaces()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": "读取网卡失败: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "interfaces": ifaces})
}

func handleInspectDomain(c *gin.Context) {
	var req struct {
		Name string `json:"name"`
	}
	if strings.HasPrefix(c.GetHeader("Content-Type"), "application/json") {
		if err := decodeJSON(c, &req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "请求格式错误"})
			return
		}
	} else {
		req.Name = c.PostForm("name")
	}
	name, err := normalizeRecordName(req.Name)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": err.Error()})
		return
	}
	setting, err := loadSetting()
	if err != nil || setting.CFToken == "" {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "请先配置 Cloudflare API Token"})
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	info, err := inspectDomain(ctx, setting.CFToken, name)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"ok": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"ok":      true,
		"zone":    info.ZoneName,
		"records": info.Records,
	})
}

func handleTestCloudflare(c *gin.Context) {
	var req struct {
		Token string `json:"token"`
	}
	_ = decodeJSON(c, &req)
	token := strings.TrimSpace(req.Token)
	if token == "" {
		if setting, err := loadSetting(); err == nil {
			token = setting.CFToken
		}
	}
	if token == "" {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "请先填写 API Token"})
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	body, err := verifyCFToken(ctx, token)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"ok": false, "error": "验证失败: " + describeCFError(err)})
		return
	}
	if body.Status != "" && body.Status != "active" {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "Token 状态为 " + body.Status + "，请检查是否已禁用或过期"})
		return
	}
	message := "Token 有效"
	if !body.ExpiresOn.IsZero() {
		message += "，有效期至 " + body.ExpiresOn.Local().Format("2006-01-02 15:04")
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "message": message})
}

func handleTestTelegram(c *gin.Context) {
	var req struct {
		Token  string `json:"token"`
		ChatID string `json:"chat_id"`
	}
	_ = decodeJSON(c, &req)
	token := strings.TrimSpace(req.Token)
	chatID := strings.TrimSpace(req.ChatID)
	if token == "" || chatID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "请先填写 Bot Token 和 Chat ID"})
		return
	}
	host, _ := os.Hostname()
	if host == "" {
		host = "ddns-panel"
	}
	text := fmt.Sprintf("🔔 <b>DDNS Panel 测试消息</b>\n\n节点：<code>%s</code>\n时间：%s\n\nTelegram 通知配置正常。", host, time.Now().Format("2006-01-02 15:04:05"))
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := sendTelegram(ctx, token, chatID, text); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"ok": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "message": "测试消息已发送，请查看 Telegram"})
}

func handleHealth(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"status":  "ok",
		"version": Version,
		"uptime":  humanDuration(time.Since(appStart)),
		"time":    time.Now().Format(time.RFC3339),
		"syncing": syncRunning.Load(),
	})
}

func decodeJSON(c *gin.Context, dst any) error {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1<<20)
	return json.NewDecoder(c.Request.Body).Decode(dst)
}
