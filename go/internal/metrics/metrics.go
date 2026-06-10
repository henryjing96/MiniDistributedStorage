// Package metrics is a small, zero-dependency Prometheus text-format
// metrics registry. We don't pull in prometheus/client_golang because:
//   - the exposition format is dead simple
//   - the MVP only needs counters and gauges (plus sum/count "summary"
//     pairs for HTTP latency)
package metrics

import (
	"fmt"
	"io"
	"sort"
	"sync"
	"sync/atomic"
)

type Registry struct {
	mu       sync.Mutex
	counters map[string]*counter
	gauges   map[string]*gauge
	help     map[string]string // metric name -> help text
	typ      map[string]string // metric name -> "counter" | "gauge"
}

func New() *Registry {
	return &Registry{
		counters: map[string]*counter{},
		gauges:   map[string]*gauge{},
		help:     map[string]string{},
		typ:      map[string]string{},
	}
}

func (r *Registry) declare(name, help, kind string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.help[name] = help
	r.typ[name] = kind
}

type counter struct {
	name   string
	series map[string]*uint64 // label-string -> ptr
	mu     sync.Mutex
}

type gauge struct {
	name   string
	series map[string]*int64
	mu     sync.Mutex
}

// NewCounter registers (or returns existing) counter with a stable help string.
func (r *Registry) NewCounter(name, help string) *Counter {
	r.declare(name, help, "counter")
	r.mu.Lock()
	c, ok := r.counters[name]
	if !ok {
		c = &counter{name: name, series: map[string]*uint64{}}
		r.counters[name] = c
	}
	r.mu.Unlock()
	return &Counter{c: c}
}

func (r *Registry) NewGauge(name, help string) *Gauge {
	r.declare(name, help, "gauge")
	r.mu.Lock()
	g, ok := r.gauges[name]
	if !ok {
		g = &gauge{name: name, series: map[string]*int64{}}
		r.gauges[name] = g
	}
	r.mu.Unlock()
	return &Gauge{g: g}
}

type Counter struct{ c *counter }

func (c *Counter) Inc(labels ...string) { c.Add(1, labels...) }

func (c *Counter) Add(delta uint64, labels ...string) {
	key := encodeLabels(labels)
	c.c.mu.Lock()
	p, ok := c.c.series[key]
	if !ok {
		var v uint64
		p = &v
		c.c.series[key] = p
	}
	c.c.mu.Unlock()
	atomic.AddUint64(p, delta)
}

type Gauge struct{ g *gauge }

func (g *Gauge) Set(v int64, labels ...string) {
	key := encodeLabels(labels)
	g.g.mu.Lock()
	p, ok := g.g.series[key]
	if !ok {
		var x int64
		p = &x
		g.g.series[key] = p
	}
	g.g.mu.Unlock()
	atomic.StoreInt64(p, v)
}

// WriteText emits the registry in Prometheus text exposition format.
func (r *Registry) WriteText(w io.Writer) {
	r.mu.Lock()
	names := make([]string, 0, len(r.help))
	for n := range r.help {
		names = append(names, n)
	}
	r.mu.Unlock()
	sort.Strings(names)
	for _, n := range names {
		r.mu.Lock()
		kind := r.typ[n]
		help := r.help[n]
		r.mu.Unlock()
		fmt.Fprintf(w, "# HELP %s %s\n", n, help)
		fmt.Fprintf(w, "# TYPE %s %s\n", n, kind)
		switch kind {
		case "counter":
			r.mu.Lock()
			c := r.counters[n]
			r.mu.Unlock()
			c.mu.Lock()
			keys := make([]string, 0, len(c.series))
			for k := range c.series {
				keys = append(keys, k)
			}
			c.mu.Unlock()
			sort.Strings(keys)
			for _, k := range keys {
				c.mu.Lock()
				p := c.series[k]
				c.mu.Unlock()
				fmt.Fprintf(w, "%s%s %d\n", n, k, atomic.LoadUint64(p))
			}
		case "gauge":
			r.mu.Lock()
			g := r.gauges[n]
			r.mu.Unlock()
			g.mu.Lock()
			keys := make([]string, 0, len(g.series))
			for k := range g.series {
				keys = append(keys, k)
			}
			g.mu.Unlock()
			sort.Strings(keys)
			for _, k := range keys {
				g.mu.Lock()
				p := g.series[k]
				g.mu.Unlock()
				fmt.Fprintf(w, "%s%s %d\n", n, k, atomic.LoadInt64(p))
			}
		}
	}
}

// encodeLabels turns ["method","GET","status","200"] into `{method="GET",status="200"}`
// and "" for no labels.
func encodeLabels(labels []string) string {
	if len(labels) == 0 {
		return ""
	}
	if len(labels)%2 != 0 {
		labels = append(labels, "")
	}
	parts := make([]string, 0, len(labels)/2)
	for i := 0; i < len(labels); i += 2 {
		parts = append(parts, fmt.Sprintf(`%s=%q`, labels[i], labels[i+1]))
	}
	return "{" + joinComma(parts) + "}"
}

func joinComma(ss []string) string {
	out := ""
	for i, s := range ss {
		if i > 0 {
			out += ","
		}
		out += s
	}
	return out
}
