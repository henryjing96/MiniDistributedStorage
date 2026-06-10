package coordinator

import (
	"context"
	"net/http"
	"sync"
	"time"
)

// nodeProbe tracks health of each configured storage node. A background
// goroutine pings /healthz periodically; pickNodes / streamBlock consult
// the live status so a downed node is skipped fast instead of timing out.
type nodeProbe struct {
	interval time.Duration
	timeout  time.Duration
	client   *http.Client
	nodes    []string

	mu      sync.RWMutex
	up      map[string]bool
	lastErr map[string]string

	cancel context.CancelFunc
	done   chan struct{}

	onChange func(node string, up bool)
}

func newNodeProbe(nodes []string, interval, timeout time.Duration, onChange func(string, bool)) *nodeProbe {
	p := &nodeProbe{
		interval: interval,
		timeout:  timeout,
		client:   &http.Client{Timeout: timeout},
		nodes:    nodes,
		up:       map[string]bool{},
		lastErr:  map[string]string{},
		onChange: onChange,
	}
	// optimistic start: assume up so we don't reject all writes for the first tick
	for _, n := range nodes {
		p.up[n] = true
	}
	return p
}

func (p *nodeProbe) start() {
	if p.interval <= 0 {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	p.cancel = cancel
	p.done = make(chan struct{})
	go p.loop(ctx)
}

func (p *nodeProbe) stop() {
	if p.cancel != nil {
		p.cancel()
		<-p.done
	}
}

func (p *nodeProbe) isUp(node string) bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.up[node]
}

func (p *nodeProbe) loop(ctx context.Context) {
	defer close(p.done)
	// first round: immediate
	p.probeAll(ctx)
	t := time.NewTicker(p.interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			p.probeAll(ctx)
		}
	}
}

func (p *nodeProbe) probeAll(ctx context.Context) {
	var wg sync.WaitGroup
	for _, n := range p.nodes {
		wg.Add(1)
		go func(node string) {
			defer wg.Done()
			p.probeOne(ctx, node)
		}(n)
	}
	wg.Wait()
}

func (p *nodeProbe) probeOne(ctx context.Context, node string) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, node+"/healthz", nil)
	if err != nil {
		p.set(node, false, err.Error())
		return
	}
	resp, err := p.client.Do(req)
	if err != nil {
		p.set(node, false, err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		p.set(node, false, resp.Status)
		return
	}
	p.set(node, true, "")
}

func (p *nodeProbe) set(node string, up bool, errStr string) {
	p.mu.Lock()
	prev, known := p.up[node]
	p.up[node] = up
	p.lastErr[node] = errStr
	p.mu.Unlock()
	if p.onChange != nil && (!known || prev != up) {
		p.onChange(node, up)
	}
}
