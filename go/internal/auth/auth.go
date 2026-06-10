// Package auth implements bearer-token authentication for HTTP handlers.
//
// Tokens are loaded by main() from (in priority order):
//   1. --token-file <path>  — preferred (file content, trimmed)
//   2. --token <value>      — flag (not recommended; visible in ps)
//   3. MINIDSS_TOKEN env    — convenient
//   4. none                 — auth disabled (backward compatibility)
//
// The same shared token is used for both client→coordinator and
// coordinator→storage traffic in this MVP. Set the same value on all
// components, or none of them.
package auth

import (
	"crypto/subtle"
	"net/http"
	"os"
	"strings"
)

const HeaderName = "Authorization"
const HeaderPrefix = "Bearer "

// Load returns a token from the listed sources, or "" if none configured.
// tokenFile takes precedence over inline, which takes precedence over env.
func Load(tokenFile, inline, envName string) (string, error) {
	if tokenFile != "" {
		b, err := os.ReadFile(tokenFile)
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(string(b)), nil
	}
	if inline != "" {
		return inline, nil
	}
	if envName != "" {
		if v := os.Getenv(envName); v != "" {
			return v, nil
		}
	}
	return "", nil
}

// Middleware enforces the token for any path EXCEPT those in openPaths.
// If token == "", auth is disabled and the handler runs unchecked.
func Middleware(token string, openPaths map[string]bool, next http.Handler) http.Handler {
	if token == "" {
		return next
	}
	expected := []byte(token)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if openPaths[r.URL.Path] {
			next.ServeHTTP(w, r)
			return
		}
		h := r.Header.Get(HeaderName)
		if !strings.HasPrefix(h, HeaderPrefix) {
			w.Header().Set("WWW-Authenticate", "Bearer")
			http.Error(w, "missing bearer token", http.StatusUnauthorized)
			return
		}
		got := []byte(strings.TrimPrefix(h, HeaderPrefix))
		if subtle.ConstantTimeCompare(got, expected) != 1 {
			http.Error(w, "invalid token", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Apply adds the Bearer header to an outbound request if token != "".
func Apply(req *http.Request, token string) {
	if token != "" {
		req.Header.Set(HeaderName, HeaderPrefix+token)
	}
}
