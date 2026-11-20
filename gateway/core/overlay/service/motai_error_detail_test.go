package service

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestSanitizeErrorDetail(t *testing.T) {
	longKey := strings.Repeat("a1B2_c3-", 5) // 40 characters
	for _, test := range []struct {
		name string
		in   string
		want string
	}{
		{"empty", "", ""},
		{"only whitespace and controls", " \t\r\n\x00\x07 ", ""},
		{"plain chinese", "余额不足，请充值", "余额不足，请充值"},
		{"model missing", "The model `gpt-9` does not exist", "The model `gpt-9` does not exist"},
		{"control characters dropped", "bad\x00 req\x1buest\x7f", "bad request"},
		{"whitespace collapsed and trimmed", "  quota \n\t exceeded   today  ", "quota exceeded today"},
		{"cloudflare html page", "<!DOCTYPE html>\n<html><head><title>502 Bad Gateway</title><style>body{color:red}</style><script>var a=1;</script></head>\n<body><center><h1>502 Bad Gateway</h1></center><hr><center>cloudflare</center><!-- a comment --></body></html>", "502 Bad Gateway 502 Bad Gateway cloudflare"},
		{"sk key", "Incorrect API key provided: sk-proj-AbCdEf123456. You can find it.", "Incorrect API key provided: [redacted]. You can find it."},
		{"short sk key", "key sk-abc rejected", "key [redacted] rejected"},
		{"word containing sk- is not a key", "task-force and risk-free", "task-force and risk-free"},
		{"bearer token", "invalid header Authorization: Bearer abc.DEF-123 end", "invalid header Authorization: [redacted] end"},
		{"bearer case-insensitive", "got bearer   xyz", "got [redacted]"},
		{"long opaque token", "token " + longKey + " expired", "token [redacted] expired"},
		{"31 characters is kept", "id " + strings.Repeat("a", 31), "id " + strings.Repeat("a", 31)},
		{"32 characters is redacted", "id " + strings.Repeat("a", 32), "id [redacted]"},
		{"invalid utf8 dropped", "ok\xff\xfe done", "ok done"},
		{"lone angle bracket kept", "need a < b and c > d", "need a < b and c > d"},
	} {
		t.Run(test.name, func(t *testing.T) {
			require.Equal(t, test.want, sanitizeErrorDetail(test.in))
		})
	}
}

func TestSanitizeErrorDetailTruncatesByRune(t *testing.T) {
	got := sanitizeErrorDetail(strings.Repeat("额", 600))
	require.Equal(t, 512, utf8.RuneCountInString(got))
	require.True(t, utf8.ValidString(got))
	exact := strings.Repeat("额", 512)
	require.Equal(t, exact, sanitizeErrorDetail(exact))
	// Index 511 of "abc abc ..." is a space, so the cut leaves a trailing space that must be trimmed.
	words := strings.Repeat("abc ", 200)
	got = sanitizeErrorDetail(words)
	require.Equal(t, 511, utf8.RuneCountInString(got))
	require.Equal(t, strings.TrimSpace(words[:512]), got)
}

func TestSanitizeErrorDetailRedactsBeforeTruncating(t *testing.T) {
	// The key starts at rune 500 and runs past 512. Redacting first keeps the whole key out of the result;
	// truncating first would leave a readable "sk-ZZZ..." prefix.
	in := strings.Repeat("x ", 250) + "sk-" + strings.Repeat("Z", 100)
	got := sanitizeErrorDetail(in)
	require.NotContains(t, got, "sk-")
	require.NotContains(t, got, "ZZZ")
	require.True(t, strings.HasSuffix(got, "x [redacted]"))
}

func TestObserveMotaiTerminalRecordsSanitizedErrorDetail(t *testing.T) {
	t.Setenv("MOTAI_GATEWAY_NO_CHARGE", "1")
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	apiErr := types.WithOpenAIError(types.OpenAIError{Message: "  余额不足 <b>sk-secret123</b>\n", Type: "insufficient_quota", Code: "insufficient_quota"}, http.StatusForbidden)
	ObserveMotaiTerminal(c, nil, apiErr)
	require.Equal(t, "余额不足 [redacted]", c.GetString("motai_error_detail"))
}

func TestObserveMotaiTerminalSkipsEmptyErrorDetail(t *testing.T) {
	t.Setenv("MOTAI_GATEWAY_NO_CHARGE", "1")
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	ObserveMotaiTerminal(c, nil, types.NewError(errors.New("\x00 \n"), types.ErrorCodeBadResponse))
	_, present := c.Get("motai_error_detail")
	require.False(t, present)
	c2, _ := gin.CreateTestContext(httptest.NewRecorder())
	c2.Request = httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	ObserveMotaiTerminal(c2, nil, nil)
	_, present = c2.Get("motai_error_detail")
	require.False(t, present)
}
