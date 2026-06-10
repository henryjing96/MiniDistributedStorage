package storagesrv

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var hashRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

type Server struct {
	DataDir string
	NodeID  string
	logger  *log.Logger
}

func New(dataDir, nodeID string, logger *log.Logger) (*Server, error) {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, err
	}
	if logger == nil {
		logger = log.Default()
	}
	return &Server{DataDir: dataDir, NodeID: nodeID, logger: logger}, nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("/blocks/", s.handleBlock)
	return mux
}

func (s *Server) blockPath(id string) string {
	return filepath.Join(s.DataDir, id[:2], id[2:])
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
		// already on disk — drain body, verify hash matches the path id
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
