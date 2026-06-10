package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"minidss/internal/auth"
	"minidss/internal/logger"
	"minidss/internal/storagesrv"
)

func main() {
	addr := flag.String("addr", envOr("MINIDSS_ADDR", ":9982"), "listen address")
	dataDir := flag.String("data", envOr("MINIDSS_DATA", "data"), "data directory")
	nodeID := flag.String("id", envOr("MINIDSS_NODE_ID", ""), "node id (informational)")
	tokenFile := flag.String("token-file", envOr("MINIDSS_TOKEN_FILE", ""),
		"path to file containing bearer token (preferred)")
	tokenInline := flag.String("token", "", "inline bearer token (use --token-file in prod)")
	flag.Parse()

	token, err := auth.Load(*tokenFile, *tokenInline, "MINIDSS_TOKEN")
	if err != nil {
		log.Fatalf("load token: %v", err)
	}

	lg := logger.New("storage")
	srv, err := storagesrv.New(storagesrv.Config{
		DataDir: *dataDir, NodeID: *nodeID, Token: token,
	}, lg)
	if err != nil {
		log.Fatalf("init storage: %v", err)
	}
	httpSrv := &http.Server{
		Addr:              *addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		lg.Info("listening", map[string]any{
			"addr": *addr, "data": *dataDir, "id": *nodeID, "auth_enabled": token != "",
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

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
