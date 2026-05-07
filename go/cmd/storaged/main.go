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

	"minidss/internal/storagesrv"
)

func main() {
	addr := flag.String("addr", envOr("MINIDSS_ADDR", ":9982"), "listen address")
	dataDir := flag.String("data", envOr("MINIDSS_DATA", "data"), "data directory")
	nodeID := flag.String("id", envOr("MINIDSS_NODE_ID", ""), "node id (informational)")
	flag.Parse()

	srv, err := storagesrv.New(*dataDir, *nodeID, log.Default())
	if err != nil {
		log.Fatalf("init storage: %v", err)
	}
	httpSrv := &http.Server{
		Addr:              *addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("storage listening on %s | data=%s id=%s", *addr, *dataDir, *nodeID)
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Println("shutting down...")
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
