GO       ?= go
BIN      := bin
LDFLAGS  ?= -s -w
GOFLAGS  ?=

.PHONY: all build clean tidy fmt vet test \
        coordinatord storaged dssctl \
        run-coord run-stor1 run-stor2 run-stor3 \
        docker-build compose-up compose-down

all: build

build: $(BIN)/coordinatord $(BIN)/storaged $(BIN)/dssctl

$(BIN)/coordinatord: $(shell find cmd/coordinatord internal/coordinator internal/metastore internal/proto -name '*.go' 2>/dev/null) go.mod
	@mkdir -p $(BIN)
	$(GO) build $(GOFLAGS) -ldflags='$(LDFLAGS)' -o $@ ./cmd/coordinatord

$(BIN)/storaged: $(shell find cmd/storaged internal/storagesrv -name '*.go' 2>/dev/null) go.mod
	@mkdir -p $(BIN)
	$(GO) build $(GOFLAGS) -ldflags='$(LDFLAGS)' -o $@ ./cmd/storaged

$(BIN)/dssctl: $(shell find cmd/dssctl internal/chunk internal/proto -name '*.go' 2>/dev/null) go.mod
	@mkdir -p $(BIN)
	$(GO) build $(GOFLAGS) -ldflags='$(LDFLAGS)' -o $@ ./cmd/dssctl

tidy:
	$(GO) mod tidy

fmt:
	$(GO) fmt ./...

vet:
	$(GO) vet ./...

test:
	$(GO) test ./...

clean:
	rm -rf $(BIN) coordinator.db coordinator.db-* data data-stor*

# --- Local dev: run components in three terminals (or use compose) ---
run-stor1: $(BIN)/storaged
	$(BIN)/storaged -addr :9982 -data data-stor1 -id node-1
run-stor2: $(BIN)/storaged
	$(BIN)/storaged -addr :9983 -data data-stor2 -id node-2
run-stor3: $(BIN)/storaged
	$(BIN)/storaged -addr :9984 -data data-stor3 -id node-3
run-coord: $(BIN)/coordinatord
	$(BIN)/coordinatord -addr :9981 -db coordinator.db \
	  -nodes 'http://127.0.0.1:9982,http://127.0.0.1:9983,http://127.0.0.1:9984'

# --- Docker ---
docker-build:
	docker build -f Dockerfile.coordinator -t minidss-coordinator .
	docker build -f Dockerfile.storage     -t minidss-storage     .

compose-up:
	docker compose up --build

compose-down:
	docker compose down -v
