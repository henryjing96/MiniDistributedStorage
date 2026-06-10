package coordinator

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"minidss/internal/metastore"
	"minidss/internal/proto"
)

type Config struct {
	StorageNodes []string // base URLs, e.g. http://storage1:9982
	Replicas     int      // 1..len(StorageNodes)
}

type Server struct {
	store  *metastore.Store
	cfg    Config
	client *http.Client
	logger *log.Logger
}

func New(store *metastore.Store, cfg Config, logger *log.Logger) (*Server, error) {
	if len(cfg.StorageNodes) == 0 {
		return nil, errors.New("no storage nodes configured")
	}
	if cfg.Replicas <= 0 {
		cfg.Replicas = 1
	}
	if cfg.Replicas > len(cfg.StorageNodes) {
		return nil, fmt.Errorf("replicas %d > storage nodes %d", cfg.Replicas, len(cfg.StorageNodes))
	}
	if logger == nil {
		logger = log.Default()
	}
	return &Server{
		store:  store,
		cfg:    cfg,
		client: &http.Client{Timeout: 60 * time.Second},
		logger: logger,
	}, nil
}

// pickNodes returns the deterministic ordered list of storage nodes for a
// given block hash, using rendezvous (HRW) hashing. The first cfg.Replicas
// entries are the canonical replicas; later entries are fall-backs for
// reads when a primary is unreachable.
func (s *Server) pickNodes(blockSHA string) []string {
	type sc struct {
		node  string
		score uint64
	}
	scs := make([]sc, len(s.cfg.StorageNodes))
	for i, node := range s.cfg.StorageNodes {
		h := sha256.New()
		h.Write([]byte(blockSHA))
		h.Write([]byte{0})
		h.Write([]byte(node))
		sum := h.Sum(nil)
		scs[i] = sc{node, binary.BigEndian.Uint64(sum[:8])}
	}
	sort.Slice(scs, func(i, j int) bool { return scs[i].score < scs[j].score })
	out := make([]string, len(scs))
	for i, x := range scs {
		out[i] = x.node
	}
	return out
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("/v1/files", s.handleFiles)
	mux.HandleFunc("/v1/files/", s.handleFile)
	return mux
}

func (s *Server) handleFiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	files, err := s.store.ListFiles()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	out := make([]proto.FileEntry, 0, len(files))
	for _, f := range files {
		out = append(out, proto.FileEntry{
			Name: f.Name, Size: f.Size, SHA256: f.SHA256,
			State: f.State, UpdatedAt: f.UpdatedAt,
		})
	}
	writeJSON(w, out)
}

// Routes (under /v1/files/):
//   {name}                 GET (download stream), DELETE
//   {name}/init            POST  (resumable manifest registration)
//   {name}/blocks/{idx}    PUT   (upload), GET (download single block)
//   {name}/commit          POST
//   {name}/manifest        GET
func (s *Server) handleFile(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/v1/files/")
	if rest == "" {
		http.NotFound(w, r)
		return
	}
	parts := strings.SplitN(rest, "/", 3)
	rawName := parts[0]
	name, err := url.PathUnescape(rawName)
	if err != nil {
		http.Error(w, "bad name", 400)
		return
	}
	if !validName(name) {
		http.Error(w, "invalid filename", 400)
		return
	}

	if len(parts) == 1 {
		switch r.Method {
		case http.MethodGet:
			s.download(w, r, name)
		case http.MethodDelete:
			s.delete(w, r, name)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
		return
	}

	switch parts[1] {
	case "init":
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", 405)
			return
		}
		s.initUpload(w, r, name)
	case "commit":
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", 405)
			return
		}
		s.commit(w, r, name)
	case "manifest":
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", 405)
			return
		}
		s.manifest(w, r, name)
	case "blocks":
		if len(parts) < 3 {
			http.Error(w, "missing block index", 400)
			return
		}
		idx, err := strconv.Atoi(parts[2])
		if err != nil || idx < 0 {
			http.Error(w, "bad index", 400)
			return
		}
		switch r.Method {
		case http.MethodPut:
			s.uploadBlock(w, r, name, idx)
		case http.MethodGet:
			s.downloadBlock(w, r, name, idx)
		default:
			http.Error(w, "method not allowed", 405)
		}
	default:
		http.NotFound(w, r)
	}
}

func validName(s string) bool {
	if s == "" || len(s) > 255 {
		return false
	}
	if strings.Contains(s, "/") || strings.Contains(s, "\\") || strings.Contains(s, "..") {
		return false
	}
	for _, r := range s {
		if r < 0x20 {
			return false
		}
	}
	return true
}

func (s *Server) initUpload(w http.ResponseWriter, r *http.Request, name string) {
	var m proto.Manifest
	if err := json.NewDecoder(r.Body).Decode(&m); err != nil {
		http.Error(w, "bad manifest: "+err.Error(), 400)
		return
	}
	if m.BlockSize <= 0 || m.Size < 0 || len(m.SHA256) != proto.HashHexLen {
		http.Error(w, "invalid manifest", 400)
		return
	}
	rows := make([]metastore.BlockRow, 0, len(m.Blocks))
	for _, b := range m.Blocks {
		if len(b.SHA256) != proto.HashHexLen || b.Size <= 0 {
			http.Error(w, "invalid block info", 400)
			return
		}
		ranked := s.pickNodes(b.SHA256)
		replicas := ranked[:s.cfg.Replicas]
		rows = append(rows, metastore.BlockRow{
			Idx: b.Index, SHA256: b.SHA256, Size: b.Size,
			StorageNodes: replicas,
		})
	}
	f, err := s.store.CreateOrResume(name, m.Size, m.SHA256, m.BlockSize, rows)
	if err != nil {
		if errors.Is(err, metastore.ErrConflict) {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		http.Error(w, err.Error(), 500)
		return
	}
	missing, err := s.store.MissingBlocks(f.ID)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if missing == nil {
		missing = []int{}
	}
	writeJSON(w, proto.InitResponse{Missing: missing})
}

func (s *Server) uploadBlock(w http.ResponseWriter, r *http.Request, name string, idx int) {
	f, err := s.store.GetFile(name)
	if err != nil {
		http.Error(w, "not initialized", 404)
		return
	}
	b, err := s.store.GetBlock(f.ID, idx)
	if err != nil {
		http.Error(w, "block not registered", 404)
		return
	}
	if b.Uploaded {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusOK)
		return
	}

	// Buffer the block so we can fan out to replicas. Block size is bounded
	// by the configured manifest block size (default 4 MiB), so this is
	// memory-safe for normal workloads.
	body, err := io.ReadAll(io.LimitReader(r.Body, int64(b.Size)+1))
	if err != nil {
		http.Error(w, "read body: "+err.Error(), 400)
		return
	}
	if len(body) != b.Size {
		http.Error(w, fmt.Sprintf("block size mismatch: got %d, want %d", len(body), b.Size), 400)
		return
	}
	if got := sha256Hex(body); got != b.SHA256 {
		http.Error(w, "block hash mismatch", 400)
		return
	}

	successes, lastErr := s.fanoutPut(r.Context(), b.StorageNodes, b.SHA256, body)
	if successes == 0 {
		http.Error(w, "all replicas failed: "+errString(lastErr), http.StatusBadGateway)
		return
	}
	if successes < len(b.StorageNodes) {
		s.logger.Printf("block %s: only %d/%d replicas accepted", b.SHA256, successes, len(b.StorageNodes))
	}

	if err := s.store.MarkUploaded(f.ID, idx); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func (s *Server) fanoutPut(ctx context.Context, nodes []string, blockSHA string, body []byte) (successes int, lastErr error) {
	for _, node := range nodes {
		u := node + "/blocks/" + blockSHA
		req, err := http.NewRequestWithContext(ctx, http.MethodPut, u, bytes.NewReader(body))
		if err != nil {
			lastErr = err
			continue
		}
		req.ContentLength = int64(len(body))
		req.Header.Set("Content-Type", "application/octet-stream")
		resp, err := s.client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		drainAndClose(resp)
		if resp.StatusCode/100 != 2 {
			lastErr = fmt.Errorf("%s: %s", node, resp.Status)
			continue
		}
		successes++
	}
	return
}

func (s *Server) downloadBlock(w http.ResponseWriter, r *http.Request, name string, idx int) {
	f, err := s.store.GetFile(name)
	if err != nil {
		http.Error(w, "not found", 404)
		return
	}
	b, err := s.store.GetBlock(f.ID, idx)
	if err != nil || !b.Uploaded {
		http.Error(w, "block not available", 404)
		return
	}
	if err := s.streamBlock(r.Context(), b, w); err != nil {
		// best-effort: header may already be flushed
		s.logger.Printf("download block %s idx %d: %v", b.SHA256, b.Idx, err)
	}
}

func (s *Server) streamBlock(ctx context.Context, b *metastore.BlockRow, w io.Writer) error {
	// Try replicas in order, then fall through to non-replica nodes if
	// configured (defense in depth — useful if topology shifted).
	tried := make(map[string]bool)
	candidates := append([]string(nil), b.StorageNodes...)
	for _, n := range s.pickNodes(b.SHA256) {
		if !contains(candidates, n) {
			candidates = append(candidates, n)
		}
	}
	var lastErr error
	for _, node := range candidates {
		if tried[node] {
			continue
		}
		tried[node] = true
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, node+"/blocks/"+b.SHA256, nil)
		if err != nil {
			lastErr = err
			continue
		}
		resp, err := s.client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		if resp.StatusCode != http.StatusOK {
			drainAndClose(resp)
			lastErr = fmt.Errorf("%s: %s", node, resp.Status)
			continue
		}
		if rw, ok := w.(http.ResponseWriter); ok && rw.Header().Get("Content-Type") == "" {
			rw.Header().Set("Content-Type", "application/octet-stream")
			if cl := resp.Header.Get("Content-Length"); cl != "" {
				rw.Header().Set("Content-Length", cl)
			}
		}
		_, err = io.Copy(w, resp.Body)
		resp.Body.Close()
		return err
	}
	if lastErr == nil {
		lastErr = errors.New("no replicas")
	}
	return lastErr
}

func (s *Server) commit(w http.ResponseWriter, r *http.Request, name string) {
	f, err := s.store.GetFile(name)
	if err != nil {
		http.Error(w, "not initialized", 404)
		return
	}
	if err := s.store.MarkComplete(f.ID); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	writeJSON(w, proto.CommitResponse{OK: true})
}

func (s *Server) manifest(w http.ResponseWriter, r *http.Request, name string) {
	f, err := s.store.GetFile(name)
	if err != nil {
		http.Error(w, "not found", 404)
		return
	}
	blocks, err := s.store.ListBlocks(f.ID)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	out := proto.Manifest{
		Name: f.Name, Size: f.Size, SHA256: f.SHA256, BlockSize: f.BlockSize,
	}
	for _, b := range blocks {
		out.Blocks = append(out.Blocks, proto.BlockInfo{
			Index: b.Idx, Size: b.Size, SHA256: b.SHA256,
		})
	}
	writeJSON(w, out)
}

func (s *Server) download(w http.ResponseWriter, r *http.Request, name string) {
	f, err := s.store.GetFile(name)
	if err != nil {
		http.Error(w, "not found", 404)
		return
	}
	if f.State != "complete" {
		http.Error(w, "incomplete file", http.StatusConflict)
		return
	}
	blocks, err := s.store.ListBlocks(f.ID)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(f.Size, 10))
	for i := range blocks {
		b := &blocks[i]
		if err := s.streamBlock(r.Context(), b, w); err != nil {
			s.logger.Printf("download %s: block %d: %v", name, b.Idx, err)
			return
		}
	}
}

func (s *Server) delete(w http.ResponseWriter, r *http.Request, name string) {
	f, err := s.store.GetFile(name)
	if err != nil {
		http.Error(w, "not found", 404)
		return
	}
	blocks, err := s.store.ListBlocks(f.ID)
	if err == nil {
		for _, b := range blocks {
			for _, node := range b.StorageNodes {
				req, _ := http.NewRequestWithContext(r.Context(),
					http.MethodDelete, node+"/blocks/"+b.SHA256, nil)
				resp, err := s.client.Do(req)
				if err == nil {
					drainAndClose(resp)
				}
			}
		}
	}
	if err := s.store.Delete(f.Name); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func sha256Hex(b []byte) string {
	h := sha256.Sum256(b)
	return fmt.Sprintf("%x", h)
}

func drainAndClose(resp *http.Response) {
	if resp == nil {
		return
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
}

func errString(err error) string {
	if err == nil {
		return "<nil>"
	}
	return err.Error()
}

func contains(ss []string, x string) bool {
	for _, s := range ss {
		if s == x {
			return true
		}
	}
	return false
}
