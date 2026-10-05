//go:build !supabase_sdk

package main

import (
	"errors"
	"os"
)

func init() {
	supabaseProbeFactory = func() (supabaseProbe, error) {
		if os.Getenv("SCW_SUPABASE_PROBE_TABLE") != "" {
			return nil, errors.New("SUPABASE_SDK_DISABLED")
		}
		return nil, nil
	}
}
