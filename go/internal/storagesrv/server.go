package storagesrv

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"minidss/internal/auth"
	"minidss/internal/logger"
	"minidss/internal/metrics"
)

var hashRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

type Config struct {
	DataDir string
	NodeID  string
	Token   string
}

type Server struct {
	cfg     Config
	log     *logger.Logger
	metrics *storageMetrics
	// cached counters refreshed lazily when /metrics is scraped
	blockCount atomic.Int64
	byteCount  atomic.Int64
	lastScan   atomic.Int64 // unix seconds
}

type storageMetrics struct {
	registry        *metrics.Registry
	httpRequests    *metrics.Counter
	httpDurationSum *metrics.Counter
	httpDurationCnt *metrics.Counter
	blocksTotal     *metrics.Gauge
	bytesTotal      *metrics.Gauge
}

func newStorageMetrics() *storageMetrics {
	r := metrics.New()
	return &storageMetrics{
		registry:        r,
		httpRequests:    r.NewCounter("minidss_http_requests_total", "HTTP requests served"),
		httpDurationSum: r.NewCounter("minidss_http_request_duration_ms_sum", "Sum of HTTP request durations in ms"),
		httpDurationCnt: r.NewCounter("minidss_http_request_duration_ms_count", "Count of HTTP requests measured"),
		blocksTotal:     r.NewGauge("minidss_storage_blocks_total", "Number of blocks stored locally"),
		bytesTotal:      r.NewGauge("minidss_storage_bytes_total", "Total bytes stored locally"),
	}
}

func New(cfg Config, lg *logger.Logger) (*Server, error) {
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		return nil, err
	}
	if lg == nil {
		lg = logger.New("storage")
	}
	return &Server{cfg: cfg, log: lg, metrics: newStorageMetrics()}, nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("/metrics", s.handleMetrics)
	mux.HandleFunc("/blocks/", s.handleBlock)
	open := map[string]bool{"/healthz": true}
	withAuth := auth.Middleware(s.cfg.Token, open, mux)
	return logger.HTTPMiddleware(s.log, s.observeHTTP, withAuth)
}

func (s *Server) observeHTTP(method, _ string, status int, _ int, duration time.Duration) {
	statusStr := strconv.Itoa(status)
	s.metrics.httpRequests.Inc("method", method, "status", statusStr)
	s.metrics.httpDurationSum.Add(uint64(duration.Milliseconds()), "method", method)
	s.metrics.httpDurationCnt.Inc("method", method)
}

func (s *Server) handleMetrics(w http.ResponseWriter, _ *http.Request) {
	// refresh disk usage at most once every 5s (scanning is O(blocks))
	now := time.Now().Unix()
	if now-s.lastScan.Load() > 5 {
		s.refreshDiskUsage()
		s.lastScan.Store(now)
	}
	s.metrics.blocksTotal.Set(s.blockCount.Load())
	s.metrics.bytesTotal.Set(s.byteCount.Load())
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	s.metrics.registry.WriteText(w)
}

func (s *Server) refreshDiskUsage() {
	var blocks, bytes int64
	_ = filepath.Walk(s.cfg.DataDir, func(_ string, info os.FileInfo, err error) error {
		if err != nil || info == nil || info.IsDir() {
			return nil
		}
		blocks++
		bytes += info.Size()
		return nil
	})
	s.blockCount.Store(blocks)
	s.byteCount.Store(bytes)
}

func (s *Server) blockPath(id string) string {
	return filepath.Join(s.cfg.DataDir, id[:2], id[2:])
}

func (s *Server) handleBlock(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/blocks/")
	if !hashRe.MatchString(id) {
		http.Error(w, "invalid block id", http.StatusBadRequest)
		return
	}
	path := s.blockPath(id)

	switch r.Method {
	case http.MethodPut:
		status, err := s.put(path, id, r.Body)
		if err != nil {
			http.Error(w, err.Error(), status)
			return
		}
		w.WriteHeader(status)
	case http.MethodGet:
		f, err := os.Open(path)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				http.NotFound(w, r)
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		defer f.Close()
		st, err := f.Stat()
		if err == nil {
			w.Header().Set("Content-Length", fmt.Sprint(st.Size()))
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = io.Copy(w, f)
	case http.MethodHead:
		if _, err := os.Stat(path); err != nil {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusOK)
	case http.MethodDelete:
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// put writes the block to disk in a content-addressed location, verifying the
// stream matches the expected SHA-256 (== block id). Idempotent: an existing
// block with matching content returns 200 OK without re-writing; a mismatch
// returns 400.
func (s *Server) put(path, id string, body io.Reader) (int, error) {
	if _, err := os.Stat(path); err == nil {
		h := sha256.New()
		if _, err := io.Copy(h, body); err != nil {
			return http.StatusBadRequest, err
		}
		if hex.EncodeToString(h.Sum(nil)) != id {
			return http.StatusBadRequest, fmt.Errorf("hash mismatch")
		}
		return http.StatusOK, nil
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return http.StatusInternalServerError, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return http.StatusInternalServerError, err
	}
	tmpPath := tmp.Name()
	cleaned := false
	defer func() {
		if !cleaned {
			_ = os.Remove(tmpPath)
		}
	}()

	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, h), body); err != nil {
		_ = tmp.Close()
		return http.StatusBadRequest, err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return http.StatusInternalServerError, err
	}
	if err := tmp.Close(); err != nil {
		return http.StatusInternalServerError, err
	}
	if hex.EncodeToString(h.Sum(nil)) != id {
		return http.StatusBadRequest, fmt.Errorf("hash mismatch")
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return http.StatusInternalServerError, err
	}
	cleaned = true
	return http.StatusCreated, nil
}

