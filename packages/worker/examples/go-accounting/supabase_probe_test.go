//go:build supabase_sdk

package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSupabaseSDKProbeUsesBoundedContextAndProjectHeaders(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/rest/v1/health_probe" ||
			r.URL.Query().Get("select") != "id" ||
			r.URL.Query().Get("limit") != "1" {
			t.Fatalf("unexpected probe request: %s", r.URL.String())
		}
		if r.Header.Get("apikey") != "test-key" ||
			r.Header.Get("Authorization") != "Bearer test-key" {
			t.Fatalf("missing SDK auth headers: %v", r.Header)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("[]"))
	}))
	defer server.Close()

	t.Setenv("SCW_SUPABASE_URL", server.URL)
	t.Setenv("SCW_SUPABASE_KEY", "test-key")
	t.Setenv("SCW_SUPABASE_PROBE_TABLE", "health_probe")
	t.Setenv("SCW_SUPABASE_TIMEOUT_MS", "100")

	probe, err := newSupabaseProbeFromEnvironment()
	if err != nil {
		t.Fatal(err)
	}
	if err := probe.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestSupabaseSDKProbeRejectsUnsafeConfiguration(t *testing.T) {
	t.Setenv("SCW_SUPABASE_URL", "http://127.0.0.1")
	t.Setenv("SCW_SUPABASE_KEY", "test-key")
	t.Setenv("SCW_SUPABASE_PROBE_TABLE", "health_probe;drop")
	if _, err := newSupabaseProbeFromEnvironment(); err == nil ||
		err.Error() != "SUPABASE_PROBE_TABLE_INVALID" {
		t.Fatalf("expected table validation error, got %v", err)
	}

	t.Setenv("SCW_SUPABASE_PROBE_TABLE", "health_probe")
	t.Setenv("SCW_SUPABASE_TIMEOUT_MS", "10")
	if _, err := newSupabaseProbeFromEnvironment(); err == nil ||
		err.Error() != "SUPABASE_TIMEOUT_INVALID" {
		t.Fatalf("expected timeout validation error, got %v", err)
	}
}

func TestSupabaseSDKProbeHonorsCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer server.Close()

	t.Setenv("SCW_SUPABASE_URL", server.URL)
	t.Setenv("SCW_SUPABASE_KEY", strings.Repeat("x", 32))
	t.Setenv("SCW_SUPABASE_PROBE_TABLE", "health_probe")
	t.Setenv("SCW_SUPABASE_TIMEOUT_MS", "50")

	probe, err := newSupabaseProbeFromEnvironment()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if err := probe.Check(ctx); err == nil {
		t.Fatal("expected cancellation or timeout")
	}
}

func TestSupabaseSDKProbeIsOptIn(t *testing.T) {
	t.Setenv("SCW_SUPABASE_URL", "")
	t.Setenv("SCW_SUPABASE_KEY", "")
	t.Setenv("SCW_SUPABASE_PROBE_TABLE", "")
	probe, err := newSupabaseProbeFromEnvironment()
	if err != nil || probe != nil {
		t.Fatalf("expected no probe by default, got probe=%v err=%v", probe, err)
	}
}

func TestSupabaseSDKProbeRejectsMalformedURL(t *testing.T) {
	t.Setenv("SCW_SUPABASE_URL", "://invalid")
	t.Setenv("SCW_SUPABASE_KEY", "test-key")
	t.Setenv("SCW_SUPABASE_PROBE_TABLE", "health_probe")
	if _, err := newSupabaseProbeFromEnvironment(); err == nil ||
		err.Error() != "SUPABASE_SDK_CONFIG_INVALID" {
		t.Fatalf("expected invalid URL error, got %v", err)
	}
}
