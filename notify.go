package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

type notifyEvent struct {
	Domain  Domain
	OldIP   string
	NewIP   string
	Created bool
}

func (e notifyEvent) telegramHTML() string {
	host, _ := os.Hostname()
	if host == "" {
		host = "ddns-panel"
	}
	title := "DDNS 记录已更新"
	change := fmt.Sprintf("<code>%s</code> → <code>%s</code>", html.EscapeString(e.OldIP), html.EscapeString(e.NewIP))
	if e.Created {
		title = "DDNS 记录已创建"
		change = fmt.Sprintf("<code>%s</code>", html.EscapeString(e.NewIP))
	}
	return fmt.Sprintf(
		"🚀 <b>%s</b>\n\n域名：<code>%s</code>（%s）\nIP：%s\n来源：%s\n节点：<code>%s</code>\n时间：%s",
		title,
		html.EscapeString(e.Domain.RecordName),
		html.EscapeString(e.Domain.RecordType),
		change,
		html.EscapeString(e.Domain.SourceText()),
		html.EscapeString(host),
		time.Now().Format("2006-01-02 15:04:05"),
	)
}

func sendTelegram(ctx context.Context, token, chatID, text string) error {
	if strings.TrimSpace(token) == "" || strings.TrimSpace(chatID) == "" {
		return fmt.Errorf("请先填写 Bot Token 和 Chat ID")
	}
	payload, err := json.Marshal(map[string]any{
		"chat_id":                  strings.TrimSpace(chatID),
		"text":                     text,
		"parse_mode":               "HTML",
		"disable_web_page_preview": true,
	})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.telegram.org/bot"+token+"/sendMessage", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "ddns-panel/"+Version)
	client := &http.Client{Timeout: 12 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("无法连接 Telegram: %s", shortNetError(err))
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
	var result struct {
		OK          bool   `json:"ok"`
		Description string `json:"description"`
	}
	_ = json.Unmarshal(body, &result)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || !result.OK {
		if result.Description != "" {
			return fmt.Errorf("Telegram 返回错误: %s", result.Description)
		}
		return fmt.Errorf("Telegram 请求失败 (HTTP %d)", resp.StatusCode)
	}
	return nil
}

func dispatchNotifications(setting Setting, events []notifyEvent) {
	if len(events) == 0 || setting.TelegramBotToken == "" || setting.TelegramChatID == "" {
		return
	}
	token, chatID := setting.TelegramBotToken, setting.TelegramChatID
	go func() {
		for _, event := range events {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			err := sendTelegram(ctx, token, chatID, event.telegramHTML())
			cancel()
			if err != nil {
				addLog("ERROR", "[%s] Telegram 通知发送失败: %v", event.Domain.RecordName, err)
			}
		}
	}()
}
