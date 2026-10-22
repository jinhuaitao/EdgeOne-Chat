package main

import (
	"crypto/subtle"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-contrib/sessions"
	"github.com/gin-contrib/sessions/cookie"
	"github.com/gin-gonic/gin"
)

const (
	sessionName  = "ddns_panel_session"
	themeCookie  = "ddns_theme"
	maxBodyBytes = 8 << 20
)

func newSessionMiddleware(secret string) gin.HandlerFunc {
	store := cookie.NewStore([]byte(secret))
	store.Options(sessions.Options{
		Path:     "/",
		MaxAge:   60 * 60 * 24 * 7,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	return sessions.Sessions(sessionName, store)
}

func saveSession(c *gin.Context) error {
	s := sessions.Default(c)
	s.Options(sessions.Options{
		Path:     "/",
		MaxAge:   60 * 60 * 24 * 7,
		HttpOnly: true,
		Secure:   cookieSecure(c),
		SameSite: http.SameSiteLaxMode,
	})
	return s.Save()
}

func cookieSecure(c *gin.Context) bool {
	switch conf.CookieSecure {
	case "true":
		return true
	case "false":
		return false
	}
	if c.Request.TLS != nil {
		return true
	}
	return strings.EqualFold(c.GetHeader("X-Forwarded-Proto"), "https")
}

func sessionUser(c *gin.Context) string {
	value := sessions.Default(c).Get("user")
	user, _ := value.(string)
	return user
}

func csrfToken(c *gin.Context) string {
	value := sessions.Default(c).Get("csrf")
	token, _ := value.(string)
	return token
}

func csrfMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		s := sessions.Default(c)
		expected := csrfToken(c)
		if expected == "" {
			expected = randomToken(24)
			s.Set("csrf", expected)
			if err := saveSession(c); err != nil {
				log.Printf("保存会话失败: %v", err)
			}
		}
		if isUnsafeMethod(c.Request.Method) {
			supplied := c.GetHeader("X-CSRF-Token")
			if supplied == "" {
				supplied = c.PostForm("csrf_token")
			}
			if supplied == "" || subtle.ConstantTimeCompare([]byte(supplied), []byte(expected)) != 1 {
				if wantsJSON(c) {
					c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"ok": false, "error": "页面安全校验失败，请刷新页面后重试"})
				} else {
					renderError(c, http.StatusForbidden, "页面已过期", "安全校验失败，请刷新页面后重新操作。")
					c.Abort()
				}
				return
			}
		}
		c.Next()
	}
}

func installGuard() gin.HandlerFunc {
	return func(c *gin.Context) {
		path := c.Request.URL.Path
		if !installed.Load() {
			if path != "/install" {
				c.Redirect(http.StatusFound, "/install")
				c.Abort()
				return
			}
			c.Next()
			return
		}
		if path == "/install" {
			c.Redirect(http.StatusFound, "/")
			c.Abort()
			return
		}
		c.Next()
	}
}

func requireAuthPage() gin.HandlerFunc {
	return func(c *gin.Context) {
		if sessionUser(c) == "" {
			next := c.Request.URL.RequestURI()
			c.Redirect(http.StatusFound, "/login?next="+url.QueryEscape(next))
			c.Abort()
			return
		}
		c.Next()
	}
}

func requireAuthAPI() gin.HandlerFunc {
	return func(c *gin.Context) {
		if sessionUser(c) == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"ok": false, "error": "登录状态已失效，请重新登录"})
			return
		}
		c.Next()
	}
}

func securityHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		h := c.Writer.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "same-origin")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		h.Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'")
		if c.Request.TLS != nil {
			h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		path := c.Request.URL.Path
		if !strings.HasPrefix(path, "/static/") && path != "/favicon.ico" && path != "/healthz" {
			h.Set("Cache-Control", "no-store")
		}
		if isUnsafeMethod(c.Request.Method) && c.Request.Body != nil {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxBodyBytes)
		}
		c.Next()
	}
}

func accessLog() gin.HandlerFunc {
	return func(c *gin.Context) {
		path := c.Request.URL.Path
		if strings.HasPrefix(path, "/static/") || path == "/favicon.ico" || path == "/healthz" {
			c.Next()
			return
		}
		start := time.Now()
		c.Next()
		log.Printf("%s %s %d %s", c.Request.Method, path, c.Writer.Status(), time.Since(start).Round(time.Millisecond))
	}
}

func isUnsafeMethod(method string) bool {
	return method == http.MethodPost || method == http.MethodPut || method == http.MethodPatch || method == http.MethodDelete
}

func wantsJSON(c *gin.Context) bool {
	if strings.HasPrefix(c.Request.URL.Path, "/api/") {
		return true
	}
	if strings.EqualFold(c.GetHeader("X-Requested-With"), "fetch") {
		return true
	}
	return strings.Contains(c.GetHeader("Accept"), "application/json")
}

func themeFromRequest(c *gin.Context) string {
	theme, err := c.Cookie(themeCookie)
	if err != nil {
		return "auto"
	}
	switch theme {
	case "light", "dark", "auto":
		return theme
	default:
		return "auto"
	}
}
