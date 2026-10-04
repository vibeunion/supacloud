package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"sync/atomic"
	"syscall"
	"time"
)

type record struct {
	SessionID    string `json:"sessionId"`
	Sequence     string `json:"sequence"`
	Kind         string `json:"kind"`
	InputOctets  string `json:"inputOctets"`
	OutputOctets string `json:"outputOctets"`
	RecordedAt   string `json:"recordedAt"`
}
type request struct {
	SchemaVersion int      `json:"schemaVersion"`
	ProjectRef    string   `json:"projectRef"`
	OperationID   string   `json:"operationId"`
	Records       []record `json:"records"`
}
type response struct {
	SchemaVersion int      `json:"schemaVersion"`
	ProjectRef    string   `json:"projectRef"`
	OperationID   string   `json:"operationId"`
	Records       []record `json:"records"`
}

type supabaseProbe interface {
	Check(context.Context) error
}

var supabaseProbeFactory = func() (supabaseProbe, error) {
	return nil, nil
}

var identity = regexp.MustCompile(`^[A-Za-z0-9_.:@/-]{1,128}$`)
var project = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,99}$`)

func exactUint64(value string) bool {
	parsed, err := strconv.ParseUint(value, 10, 64)
	return err == nil && strconv.FormatUint(parsed, 10) == value
}

// Accounting counters are cumulative per session, not billable deltas. This
// adapter normalizes packets only; session reconciliation and billing stay in BOSS.
func normalize(input request) (response, error) {
	if input.SchemaVersion != 1 || !identity.MatchString(input.OperationID) ||
		len(input.Records) == 0 || len(input.Records) > 1000 {
		return response{}, errors.New("INPUT_INVALID")
	}
	output := response{1, input.ProjectRef, input.OperationID, make([]record, len(input.Records))}
	for i, item := range input.Records {
		at, err := time.Parse(time.RFC3339Nano, item.RecordedAt)
		if !identity.MatchString(item.SessionID) || !exactUint64(item.Sequence) ||
			!exactUint64(item.InputOctets) || !exactUint64(item.OutputOctets) || err != nil ||
			(item.Kind != "start" && item.Kind != "interim" && item.Kind != "stop") {
			return response{}, errors.New("INPUT_INVALID")
		}
		// Preserve exact uint64 values, including numbers above JavaScript's safe range.
		item.RecordedAt = at.UTC().Format(time.RFC3339Nano)
		output.Records[i] = item
	}
	return output, nil
}

type service struct {
	project string
	token   string
	slots   chan struct{}
	probe   supabaseProbe
	ready   atomic.Bool
	calls   atomic.Uint64
	failed  atomic.Uint64
}

func newService(projectRef, token string, concurrency int) (*service, error) {
	if !project.MatchString(projectRef) || len(token) < 32 || concurrency < 1 || concurrency > 32 {
		return nil, errors.New("SERVICE_CONFIG_INVALID")
	}
	probe, err := supabaseProbeFactory()
	if err != nil {
		return nil, err
	}
	s := &service{project: projectRef, token: token, slots: make(chan struct{}, concurrency), probe: probe}
	s.ready.Store(true)
	return s, nil
}
func (s *service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method == http.MethodGet && r.URL.Path == "/live" {
		io.WriteString(w, `{"alive":true}`)
		return
	}
	if r.Method == http.MethodGet && r.URL.Path == "/ready" {
		ready := s.ready.Load()
		if ready && s.probe != nil {
			ready = s.probe.Check(r.Context()) == nil
		}
		if !ready {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		json.NewEncoder(w).Encode(map[string]bool{"ready": ready})
		return
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+s.token)) != 1 {
		http.Error(w, `{"error":"UNAUTHORIZED"}`, http.StatusUnauthorized)
		return
	}
	if r.Method == http.MethodGet && r.URL.Path == "/metrics" {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		io.WriteString(w, "scw_native_requests_total "+strconv.FormatUint(s.calls.Load(), 10)+"\n")
		io.WriteString(w, "scw_native_errors_total "+strconv.FormatUint(s.failed.Load(), 10)+"\n")
		return
	}
	if r.Method != http.MethodPost || r.URL.Path != "/v1/accounting/normalize" {
		http.Error(w, `{"error":"NOT_FOUND"}`, http.StatusNotFound)
		return
	}
	if !s.ready.Load() {
		http.Error(w, `{"error":"DRAINING"}`, http.StatusServiceUnavailable)
		return
	}
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		w.Header().Set("Retry-After", "1")
		http.Error(w, `{"error":"BUSY"}`, http.StatusTooManyRequests)
		return
	}
	s.calls.Add(1)
	r.Body = http.MaxBytesReader(w, r.Body, 1024*1024)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var input request
	if err := decoder.Decode(&input); err != nil {
		s.failed.Add(1)
		http.Error(w, `{"error":"INPUT_INVALID"}`, http.StatusBadRequest)
		return
	}
	var extra json.RawMessage
	if decoder.Decode(&extra) != io.EOF || input.ProjectRef != s.project {
		s.failed.Add(1)
		http.Error(w, `{"error":"SCOPE_OR_INPUT_INVALID"}`, http.StatusBadRequest)
		return
	}
	output, err := normalize(input)
	if err != nil {
		s.failed.Add(1)
		http.Error(w, `{"error":"INPUT_INVALID"}`, http.StatusBadRequest)
		return
	}
	if r.Context().Err() != nil {
		return
	}
	json.NewEncoder(w).Encode(output)
}

func main() {
	limit, err := strconv.Atoi(os.Getenv("SCW_NATIVE_CONCURRENCY"))
	if err != nil {
		log.Fatal("SERVICE_CONFIG_INVALID")
	}
	s, err := newService(os.Getenv("SUPACLOUD_PROJECT_REF"), os.Getenv("SCW_NATIVE_TOKEN"), limit)
	if err != nil {
		log.Fatal("SERVICE_CONFIG_INVALID")
	}
	address := os.Getenv("SCW_NATIVE_ADDRESS")
	host, _, err := net.SplitHostPort(address)
	if err != nil || (host != "127.0.0.1" && host != "::1") {
		log.Fatal("SERVICE_LOOPBACK_ADDRESS_REQUIRED")
	}
	server := &http.Server{
		Addr: address, Handler: s, ReadHeaderTimeout: 2 * time.Second,
		ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second,
		IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192,
	}
	stopped := make(chan struct{})
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-signals
		s.ready.Store(false)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if server.Shutdown(ctx) != nil {
			server.Close()
		}
		close(stopped)
	}()
	log.Print("accounting normalizer starting")
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal("SERVICE_LISTEN_FAILED")
	}
	<-stopped
}
