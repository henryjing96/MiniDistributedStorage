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

	"minidss/internal/coordinator"
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
	flag.Parse()

	nodeList := splitTrim(*nodes)
	if len(nodeList) == 0 {
		log.Fatal("no storage nodes configured")
	}

	store, err := metastore.Open(*dbPath)
	if err != nil {
		log.Fatalf("open db %q: %v", *dbPath, err)
	}
	defer store.Close()

	srv, err := coordinator.New(store, coordinator.Config{
		StorageNodes: nodeList,
		Replicas:     *replicas,
	}, log.Default())
	if err != nil {
		log.Fatalf("coordinator: %v", err)
	}

	httpSrv := &http.Server{
		Addr:              *addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("coordinator listening on %s | nodes=%v replicas=%d db=%s",
			*addr, nodeList, *replicas, *dbPath)
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
