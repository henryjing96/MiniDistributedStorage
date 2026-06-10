// Package logger provides structured JSON logging plus an HTTP middleware
// that attaches a request ID and emits an access log per request.
package logger

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"sync"
	"time"
)

type ctxKey int

const requestIDKey ctxKey = 0

const HeaderRequestID = "X-Request-Id"

type Logger struct {
	mu      sync.Mutex
	w       io.Writer
	service string
}

func New(service string) *Logger {
	return &Logger{w: os.Stdout, service: service}
}

func (l *Logger) write(level, msg string, fields map[string]any) {
	rec := map[string]any{
		"ts":      time.Now().UTC().Format(time.RFC3339Nano),
		"level":   level,
		"service": l.service,
		"msg":     msg,
	}
	for k, v := range fields {
		rec[k] = v
	}
	b, _ := json.Marshal(rec)
	b = append(b, '\n')
	l.mu.Lock()
	_, _ = l.w.Write(b)
	l.mu.Unlock()
}

func (l *Logger) Info(msg string, fields map[string]any)  { l.write("info", msg, fields) }
func (l *Logger) Warn(msg string, fields map[string]any)  { l.write("warn", msg, fields) }
func (l *Logger) Error(msg string, fields map[string]any) { l.write("error", msg, fields) }

// RequestID returns the request ID from ctx, or "" if not present.
func RequestID(ctx context.Context) string {
	v, _ := ctx.Value(requestIDKey).(string)
	return v
}

func newID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// statusWriter captures the response status + bytes written for logging.
type statusWriter struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (sw *statusWriter) WriteHeader(code int) {
	sw.status = code
	sw.ResponseWriter.WriteHeader(code)
}

func (sw *statusWriter) Write(b []byte) (int, error) {
	if sw.status == 0 {
		sw.status = http.StatusOK
	}
	n, err := sw.ResponseWriter.Write(b)
	sw.bytes += n
	return n, err
}

// HTTPMiddleware attaches a request ID, emits an access log per request,
// and (optionally) calls onObserve so callers can plug in metrics.
type ObserveFunc func(method, path string, status int, bytes int, duration time.Duration)

func HTTPMiddleware(l *Logger, observe ObserveFunc, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get(HeaderRequestID)
		if id == "" {
			id = newID()
		}
		w.Header().Set(HeaderRequestID, id)
		ctx := context.WithValue(r.Context(), requestIDKey, id)
		sw := &statusWriter{ResponseWriter: w}
		start := time.Now()
		next.ServeHTTP(sw, r.WithContext(ctx))
		dur := time.Since(start)
		if sw.status == 0 {
			sw.status = http.StatusOK
		}
		l.Info("http", map[string]any{
			"request_id":  id,
			"method":      r.Method,
			"path":        r.URL.Path,
			"status":      sw.status,
			"bytes":       sw.bytes,
			"duration_ms": dur.Milliseconds(),
			"remote":      r.RemoteAddr,
		})
		if observe != nil {
			observe(r.Method, r.URL.Path, sw.status, sw.bytes, dur)
		}
	})
}
