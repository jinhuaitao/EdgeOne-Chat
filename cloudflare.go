package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/cloudflare/cloudflare-go"
)

type zoneLookup struct {
	api   *cloudflare.API
	cache map[string]zoneResult
}

type zoneResult struct {
	id   string
	name string
	err  error
}

func newZoneLookup(api *cloudflare.API) *zoneLookup {
	return &zoneLookup{api: api, cache: make(map[string]zoneResult)}
}

func (z *zoneLookup) find(ctx context.Context, recordName string) (string, string, error) {
	labels := strings.Split(recordName, ".")
	if len(labels) < 2 {
		return "", "", fmt.Errorf("域名格式不正确")
	}
	for i := 0; i <= len(labels)-2; i++ {
		candidate := strings.Join(labels[i:], ".")
		if cached, ok := z.cache[candidate]; ok {
			if cached.err != nil {
				return "", "", cached.err
			}
			if cached.id != "" {
				return cached.id, cached.name, nil
			}
			continue
		}
		zones, err := z.api.ListZones(ctx, candidate)
		if err != nil {
			mapped := errors.New(describeCFError(err))
			z.cache[candidate] = zoneResult{err: mapped}
			return "", "", mapped
		}
		result := zoneResult{}
		for _, zone := range zones {
			if strings.EqualFold(zone.Name, candidate) {
				result.id, result.name = zone.ID, zone.Name
				break
			}
		}
		z.cache[candidate] = result
		if result.id != "" {
			return result.id, result.name, nil
		}
	}
	return "", "", fmt.Errorf("当前 Token 下找不到该域名所在的 Zone，请确认域名已添加到 Cloudflare，并授予 Zone:Read 权限")
}

func newCFClient(token string) (*cloudflare.API, error) {
	api, err := cloudflare.NewWithAPIToken(token, cloudflare.HTTPClient(&http.Client{Timeout: 20 * time.Second}))
	if err != nil {
		return nil, fmt.Errorf("Cloudflare 客户端初始化失败: %w", err)
	}
	return api, nil
}

func verifyCFToken(ctx context.Context, token string) (cloudflare.APITokenVerifyBody, error) {
	api, err := newCFClient(token)
	if err != nil {
		return cloudflare.APITokenVerifyBody{}, err
	}
	return api.VerifyAPIToken(ctx)
}

func describeCFError(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return "请求 Cloudflare 超时，请检查服务器网络"
	}
	var authErr *cloudflare.AuthenticationError
	if errors.As(err, &authErr) {
		return "Token 权限不足（需要 Zone.DNS:Edit 与 Zone:Read）"
	}
	var authorizationErr *cloudflare.AuthorizationError
	if errors.As(err, &authorizationErr) {
		return "Token 无效或已过期，请重新生成"
	}
	var notFoundErr *cloudflare.NotFoundError
	if errors.As(err, &notFoundErr) {
		return "Cloudflare 上找不到对应的资源，或 Token 无权访问该 Zone"
	}
	var rateErr *cloudflare.RatelimitError
	if errors.As(err, &rateErr) {
		return "Cloudflare 请求频率超限，请稍后重试"
	}
	var serviceErr *cloudflare.ServiceError
	if errors.As(err, &serviceErr) {
		return "Cloudflare 服务暂时不可用，请稍后重试"
	}
	var reqErr *cloudflare.RequestError
	if errors.As(err, &reqErr) {
		return "Cloudflare 拒绝了请求: " + truncateText(err.Error(), 240)
	}
	msg := err.Error()
	if strings.Contains(msg, "no such host") {
		return "无法连接 Cloudflare，请检查 DNS 与网络"
	}
	if strings.Contains(msg, "i/o timeout") || strings.Contains(msg, "deadline exceeded") {
		return "请求 Cloudflare 超时，请检查服务器网络"
	}
	return truncateText(msg, 300)
}

func truncateText(s string, limit int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) <= limit {
		return string(r)
	}
	return string(r[:limit]) + "…"
}

type inspectedRecord struct {
	Type    string `json:"type"`
	Content string `json:"content"`
	Proxied bool   `json:"proxied"`
	TTL     int    `json:"ttl"`
}

type domainInspection struct {
	ZoneID   string            `json:"zone_id"`
	ZoneName string            `json:"zone_name"`
	Records  []inspectedRecord `json:"records"`
}

func inspectDomain(ctx context.Context, token, recordName string) (domainInspection, error) {
	var out domainInspection
	api, err := newCFClient(token)
	if err != nil {
		return out, err
	}
	lookup := newZoneLookup(api)
	zoneID, zoneName, err := lookup.find(ctx, recordName)
	if err != nil {
		return out, err
	}
	out.ZoneID, out.ZoneName = zoneID, zoneName
	records, _, err := api.ListDNSRecords(ctx, cloudflare.ZoneIdentifier(zoneID), cloudflare.ListDNSRecordsParams{Name: recordName})
	if err != nil {
		return out, fmt.Errorf("读取 DNS 记录失败: %s", describeCFError(err))
	}
	for _, rec := range records {
		if rec.Type != "A" && rec.Type != "AAAA" {
			continue
		}
		proxied := rec.Proxied != nil && *rec.Proxied
		out.Records = append(out.Records, inspectedRecord{
			Type:    rec.Type,
			Content: rec.Content,
			Proxied: proxied,
			TTL:     rec.TTL,
		})
		if len(out.Records) >= 10 {
			break
		}
	}
	return out, nil
}
