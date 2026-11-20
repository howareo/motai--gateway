package service

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// motaiErrorDetailMaxRunes mirrors maxLength of terminal.error_detail in contracts/v1/records.schema.json.
const motaiErrorDetailMaxRunes = 512

var (
	// Whole <script>/<style> elements and HTML comments carry no readable error text, drop their contents too.
	motaiHTMLBlockPattern = regexp.MustCompile(`(?is)<(script|style)\b.*?</(script|style)\s*>|<!--.*?-->`)
	// Any remaining tag, doctype or closing tag. Only text between tags is kept.
	motaiHTMLTagPattern = regexp.MustCompile(`(?s)</?[A-Za-z!][^<>]*>`)
	// Secrets are replaced one rule at a time; the order matters (Bearer and sk- first, generic long token last).
	motaiBearerPattern  = regexp.MustCompile(`(?i)\bBearer\s+\S+`)
	motaiSKKeyPattern   = regexp.MustCompile(`\bsk-[A-Za-z0-9_\-]*`)
	motaiLongTokenRegex = regexp.MustCompile(`[A-Za-z0-9_\-]{32,}`)
)

// sanitizeErrorDetail turns an upstream error message into text that is safe to store in
// motai.attempts.terminal.error_detail: no markup, no control characters, no credential-looking
// strings, at most 512 runes. An empty result means "nothing worth recording"; callers treat it as null.
func sanitizeErrorDetail(raw string) string {
	text := strings.ToValidUTF8(raw, "")
	text = motaiHTMLBlockPattern.ReplaceAllString(text, " ")
	text = motaiHTMLTagPattern.ReplaceAllString(text, " ")

	// Control characters other than whitespace are dropped; every whitespace run becomes one space.
	var builder strings.Builder
	builder.Grow(len(text))
	pendingSpace := false
	for _, r := range text {
		switch {
		case unicode.IsSpace(r):
			pendingSpace = true
		case unicode.IsControl(r):
		default:
			if pendingSpace && builder.Len() > 0 {
				builder.WriteByte(' ')
			}
			pendingSpace = false
			builder.WriteRune(r)
		}
	}
	text = builder.String()

	text = motaiBearerPattern.ReplaceAllString(text, "[redacted]")
	text = motaiSKKeyPattern.ReplaceAllString(text, "[redacted]")
	text = motaiLongTokenRegex.ReplaceAllString(text, "[redacted]")

	if utf8.RuneCountInString(text) > motaiErrorDetailMaxRunes {
		text = string([]rune(text)[:motaiErrorDetailMaxRunes])
	}
	return strings.TrimSpace(text)
}
