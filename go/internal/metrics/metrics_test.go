package metrics

import (
	"bytes"
	"strings"
	"testing"
)

func TestCounterAndGaugeText(t *testing.T) {
	r := New()
	c := r.NewCounter("req_total", "requests")
	g := r.NewGauge("node_up", "node liveness")

	c.Inc("method", "GET", "status", "200")
	c.Inc("method", "GET", "status", "200")
	c.Add(3, "method", "POST", "status", "201")
	g.Set(1, "node", "n1")
	g.Set(0, "node", "n2")

	var buf bytes.Buffer
	r.WriteText(&buf)
	out := buf.String()

	mustContain(t, out, `# TYPE req_total counter`)
	mustContain(t, out, `# TYPE node_up gauge`)
	mustContain(t, out, `req_total{method="GET",status="200"} 2`)
	mustContain(t, out, `req_total{method="POST",status="201"} 3`)
	mustContain(t, out, `node_up{node="n1"} 1`)
	mustContain(t, out, `node_up{node="n2"} 0`)
}

func TestUnlabeled(t *testing.T) {
	r := New()
	c := r.NewCounter("plain_total", "no labels")
	c.Inc()
	c.Inc()
	var buf bytes.Buffer
	r.WriteText(&buf)
	mustContain(t, buf.String(), "plain_total 2")
}

func mustContain(t *testing.T, haystack, needle string) {
	t.Helper()
	if !strings.Contains(haystack, needle) {
		t.Fatalf("output missing %q\n---\n%s", needle, haystack)
	}
}
