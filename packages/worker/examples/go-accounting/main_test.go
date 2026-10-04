package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func sample() request {
	return request{1, "fixture", "operation:1", []record{
		{"session-1", "1", "interim", "18446744073709551615", "9007199254740993", "2026-10-04T08:00:00+08:00"},
	}}
}
func TestNormalize(t *testing.T) {
	output, err := normalize(sample())
	if err != nil || output.Records[0].InputOctets != "18446744073709551615" ||
		output.Records[0].OutputOctets != "9007199254740993" || output.Records[0].RecordedAt != "2026-10-04T00:00:00Z" {
		t.Fatal("normalization lost exact values", err)
	}
	for _, value := range []string{"-1", "01", "1.5", "18446744073709551616", ""} {
		input := sample()
		input.Records[0].InputOctets = value
		if _, err := normalize(input); err == nil {
			t.Fatalf("accepted %q", value)
		}
	}
}
func TestProtocol(t *testing.T) {
	token := strings.Repeat("x", 32)
	s, err := newService("fixture", token, 1)
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(sample())
	call := func(body []byte, authorization string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/v1/accounting/normalize", bytes.NewReader(body))
		r.Header.Set("Authorization", authorization)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}
	if call(payload, "Bearer "+token).Code != http.StatusOK {
		t.Fatal("valid request failed")
	}
	if call(payload, "wrong").Code != http.StatusUnauthorized {
		t.Fatal("auth bypass")
	}
	wrong := sample()
	wrong.ProjectRef = "other"
	body, _ := json.Marshal(wrong)
	if call(body, "Bearer "+token).Code != http.StatusBadRequest {
		t.Fatal("scope bypass")
	}
	for _, body := range [][]byte{[]byte("{}"), append(payload, []byte("{}")...), []byte(strings.Repeat("x", 1024*1024+1))} {
		if call(body, "Bearer "+token).Code == http.StatusOK {
			t.Fatal("accepted invalid input")
		}
	}
	s.slots <- struct{}{}
	busy := call(payload, "Bearer "+token)
	if busy.Code != http.StatusTooManyRequests || busy.Header().Get("Retry-After") != "1" {
		t.Fatal("missing backpressure")
	}
	<-s.slots
	s.ready.Store(false)
	if call(payload, "Bearer "+token).Code != http.StatusServiceUnavailable {
		t.Fatal("accepted during drain")
	}
}
