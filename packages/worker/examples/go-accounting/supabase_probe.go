//go:build supabase_sdk

package main

import (
	"context"
	"errors"
	urlpkg "net/url"
	"os"
	"regexp"
	"strconv"
	"time"

	"github.com/supabase-community/supabase-go"
)

type sdkSupabaseProbe struct {
	client  *supabase.Client
	table   string
	timeout time.Duration
}

var supabaseTable = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,62}$`)

func init() {
	supabaseProbeFactory = newSupabaseProbeFromEnvironment
}

func newSupabaseProbeFromEnvironment() (supabaseProbe, error) {
	table := os.Getenv("SCW_SUPABASE_PROBE_TABLE")
	if table == "" {
		return nil, nil
	}
	if !supabaseTable.MatchString(table) {
		return nil, errors.New("SUPABASE_PROBE_TABLE_INVALID")
	}
	rawURL := os.Getenv("SCW_SUPABASE_URL")
	key := os.Getenv("SCW_SUPABASE_KEY")
	if rawURL == "" || key == "" {
		return nil, errors.New("SUPABASE_SDK_CONFIG_INVALID")
	}
	parsed, err := urlpkg.ParseRequestURI(rawURL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return nil, errors.New("SUPABASE_SDK_CONFIG_INVALID")
	}
	timeout := 750 * time.Millisecond
	if value := os.Getenv("SCW_SUPABASE_TIMEOUT_MS"); value != "" {
		millis, err := strconv.Atoi(value)
		if err != nil || millis < 50 || millis > 5000 {
			return nil, errors.New("SUPABASE_TIMEOUT_INVALID")
		}
		timeout = time.Duration(millis) * time.Millisecond
	}
	client, err := supabase.NewClient(rawURL, key, nil)
	if err != nil {
		return nil, errors.New("SUPABASE_SDK_CONFIG_INVALID")
	}
	return &sdkSupabaseProbe{client: client, table: table, timeout: timeout}, nil
}

func (p *sdkSupabaseProbe) Check(parent context.Context) error {
	ctx, cancel := context.WithTimeout(parent, p.timeout)
	defer cancel()
	_, _, err := p.client.From(p.table).
		Select("id", "", false).
		Limit(1, "").
		ExecuteWithContext(ctx)
	return err
}
