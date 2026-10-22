package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

func handleBackup(c *gin.Context) {
	file, err := buildBackup()
	if err != nil {
		addFlash(c, "error", "生成备份失败: "+err.Error())
		c.Redirect(http.StatusFound, "/settings")
		return
	}
	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		addFlash(c, "error", "序列化备份失败: "+err.Error())
		c.Redirect(http.StatusFound, "/settings")
		return
	}
	filename := fmt.Sprintf("ddns-panel-backup-%s.json", time.Now().Format("20060102-150405"))
	c.Header("Content-Disposition", `attachment; filename="`+filename+`"`)
	c.Header("Content-Type", "application/json; charset=utf-8")
	c.Data(http.StatusOK, "application/json; charset=utf-8", data)
}

func handleRestore(c *gin.Context) {
	file, header, err := c.Request.FormFile("backup_file")
	if err != nil {
		addFlash(c, "error", "请选择要恢复的备份文件")
		c.Redirect(http.StatusFound, "/settings")
		return
	}
	defer file.Close()
	if header.Size > 2<<20 {
		addFlash(c, "error", "备份文件不能超过 2MB")
		c.Redirect(http.StatusFound, "/settings")
		return
	}
	data, err := io.ReadAll(io.LimitReader(file, 2<<20+1))
	if err != nil {
		addFlash(c, "error", "读取备份文件失败")
		c.Redirect(http.StatusFound, "/settings")
		return
	}
	if len(data) > 2<<20 {
		addFlash(c, "error", "备份文件不能超过 2MB")
		c.Redirect(http.StatusFound, "/settings")
		return
	}
	parsed, legacy, err := parseBackup(data)
	if err != nil {
		addFlash(c, "error", err.Error())
		c.Redirect(http.StatusFound, "/settings")
		return
	}
	added, updated, skipped, err := applyBackup(parsed, legacy)
	if err != nil {
		addFlash(c, "error", "恢复失败: "+err.Error())
		c.Redirect(http.StatusFound, "/settings")
		return
	}
	if setting, err := loadSetting(); err == nil && appScheduler != nil {
		appScheduler.SetInterval(time.Duration(setting.SyncMinutes) * time.Minute)
	}
	parts := []string{fmt.Sprintf("新增 %d", added), fmt.Sprintf("更新 %d", updated)}
	if skipped > 0 {
		parts = append(parts, fmt.Sprintf("跳过 %d", skipped))
	}
	addLog("INFO", "配置恢复完成：%s", strings.Join(parts, "，"))
	addFlash(c, "success", "配置恢复完成："+strings.Join(parts, "，"))
	if setting, err := loadSetting(); err == nil && setting.CFToken != "" {
		go runSync("restore")
	}
	c.Redirect(http.StatusFound, "/settings")
}
