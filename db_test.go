package main

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestNormalizeTruncation(t *testing.T) {
	long := strings.Repeat("x", 100)

	if got := normalize("short", 100); got != "short" {
		t.Errorf("under-cap string changed: %v", got)
	}
	if got := normalize([]byte("bytes"), 100); got != "bytes" {
		t.Errorf("[]byte not coerced to string: %v", got)
	}
	if got := normalize(42, 5); got != 42 {
		t.Errorf("non-string value changed: %v", got)
	}

	got, ok := normalize(long, 10).(string)
	if !ok {
		t.Fatalf("truncated value is not a string")
	}
	if !strings.HasPrefix(got, "xxxxxxxxxx") || !strings.Contains(got, "[truncated, 100 bytes total]") {
		t.Errorf("truncation marker wrong: %q", got)
	}

	// multibyte rune split at the cap boundary must not yield invalid UTF-8
	multi := strings.Repeat("é", 10) // 2 bytes each
	mgot, _ := normalize(multi, 5).(string)
	if !utf8.ValidString(mgot) {
		t.Errorf("truncated multibyte string is invalid UTF-8: %q", mgot)
	}
	if !strings.Contains(mgot, "[truncated, 20 bytes total]") {
		t.Errorf("multibyte marker wrong: %q", mgot)
	}

	if got := normalize(long, -1); got != long {
		t.Errorf("-1 must disable the cap")
	}
	if got := normalize([]byte(long), -1); got != long {
		t.Errorf("-1 must disable the cap for []byte too")
	}
}
