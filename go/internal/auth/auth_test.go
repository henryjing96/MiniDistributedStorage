package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMiddlewareDisabledWhenTokenEmpty(t *testing.T) {
	called := false
	h := Middleware("", nil, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(204)
	}))
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/foo", nil)
	h.ServeHTTP(rec, req)
	if !called {
		t.Fatal("handler not called when auth disabled")
	}
	if rec.Code != 204 {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
}

func TestMiddlewareEnforcement(t *testing.T) {
	open := map[string]bool{"/healthz": true}
	inner := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(200)
	})
	h := Middleware("sekret", open, inner)

	cases := []struct {
		name    string
		path    string
		hdr     string
		wantSts int
	}{
		{"open path bypasses", "/healthz", "", 200},
		{"missing header", "/protected", "", 401},
		{"wrong scheme", "/protected", "Token sekret", 401},
		{"wrong token", "/protected", "Bearer nope", 401},
		{"right token", "/protected", "Bearer sekret", 200},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest("GET", c.path, nil)
			if c.hdr != "" {
				req.Header.Set("Authorization", c.hdr)
			}
			h.ServeHTTP(rec, req)
			if rec.Code != c.wantSts {
				t.Errorf("status=%d, want %d (body=%q)", rec.Code, c.wantSts, rec.Body.String())
			}
		})
	}
}

func TestApply(t *testing.T) {
	req, _ := http.NewRequest("GET", "http://x/", nil)
	Apply(req, "")
	if req.Header.Get("Authorization") != "" {
		t.Fatalf("apply with empty token should not set header")
	}
	Apply(req, "abc")
	if req.Header.Get("Authorization") != "Bearer abc" {
		t.Fatalf("apply with token: header = %q", req.Header.Get("Authorization"))
	}
}
