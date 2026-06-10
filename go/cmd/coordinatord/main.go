package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"minidss/internal/auth"
	"minidss/internal/coordinator"
	"minidss/internal/logger"
	"minidss/internal/metastore"
)

func main() {
	addr := flag.String("addr", envOr("MINIDSS_ADDR", ":9981"), "listen address")
	dbPath := flag.String("db", envOr("MINIDSS_DB", "coordinator.db"), "sqlite database path")
	nodes := flag.String("nodes", envOr("MINIDSS_NODES",
		"http://127.0.0.1:9982,http://127.0.0.1:9983,http://127.0.0.1:9984"),
		"comma-separated storage node base URLs")
	replicas := flag.Int("replicas", envOrInt("MINIDSS_REPLICAS", 1),
		"replicas per block (1..N)")
	tokenFile := flag.String("token-file", envOr("MINIDSS_TOKEN_FILE", ""),
		"path to file containing bearer token (preferred)")
	tokenInline := flag.String("token", "", "inline bearer token (use --token-file in prod)")
	probeIntervalSec := flag.Int("probe-interval-sec", envOrInt("MINIDSS_PROBE_INTERVAL_SEC", 5),
		"storage node health probe interval seconds (0=disabled)")
	probeTimeoutMs := flag.Int("probe-timeout-ms", envOrInt("MINIDSS_PROBE_TIMEOUT_MS", 1000),
		"storage node health probe HTTP timeout milliseconds")
	flag.Parse()

	nodeList := splitTrim(*nodes)
	if len(nodeList) == 0 {
		log.Fatal("no storage nodes configured")
	}

	token, err := auth.Load(*tokenFile, *tokenInline, "MINIDSS_TOKEN")
	if err != nil {
		log.Fatalf("load token: %v", err)
	}

	store, err := metastore.Open(*dbPath)
	if err != nil {
		log.Fatalf("open db %q: %v", *dbPath, err)
	}
	defer store.Close()

	lg := logger.New("coordinator")
	srv, err := coordinator.New(store, coordinator.Config{
		StorageNodes:  nodeList,
		Replicas:      *replicas,
		Token:         token,
		ProbeInterval: time.Duration(*probeIntervalSec) * time.Second,
		ProbeTimeout:  time.Duration(*probeTimeoutMs) * time.Millisecond,
	}, lg)
	if err != nil {
		log.Fatalf("coordinator: %v", err)
	}
	srv.Start()
	defer srv.Stop()

	httpSrv := &http.Server{
		Addr:              *addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		lg.Info("listening", map[string]any{
			"addr": *addr, "nodes": nodeList, "replicas": *replicas,
			"db": *dbPath, "auth_enabled": token != "",
			"probe_interval_sec": *probeIntervalSec,
		})
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	lg.Info("shutdown_start", nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(ctx)
}

func splitTrim(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envOrInt(k string, def int) int {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}
