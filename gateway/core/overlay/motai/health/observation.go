package health

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// RetryAfter accepts one HTTP field value and bounds a valid delay. Its absolute
// deadline is captured at response observation, so persistence cannot extend it.
func RetryAfter(values []string, now time.Time, maxSeconds int) (time.Time, bool) {
	if len(values) != 1 || maxSeconds < 1 || maxSeconds > 86400 {
		return time.Time{}, false
	}
	value := strings.Trim(values[0], " \t")
	if value == "" || len(value) > 128 {
		return time.Time{}, false
	}
	seconds := true
	for _, char := range value {
		if char < '0' || char > '9' {
			seconds = false
			break
		}
	}
	if seconds {
		delay, err := strconv.ParseUint(value, 10, 64)
		if err != nil {
			return time.Time{}, false
		}
		if delay > uint64(maxSeconds) {
			delay = uint64(maxSeconds)
		}
		return now.Add(time.Duration(delay) * time.Second), true
	}
	deadline, err := http.ParseTime(value)
	if err != nil || deadline.Before(now) {
		return time.Time{}, false
	}
	if maximum := now.Add(time.Duration(maxSeconds) * time.Second); deadline.After(maximum) {
		deadline = maximum
	}
	return deadline, true
}

var fundsText = regexp.MustCompile(`(?:credit balance|account balance|wallet balance|remaining credits?) (?:is |are )?(?:too low|insufficient|exhausted|depleted|zero)|(?:insufficient|exhausted|depleted) (?:account |wallet |credit )?(?:balance|credits?)|(?:账户余额|帐户余额|钱包余额|可用余额|账户额度|帐户额度)(?:已)?(?:不足|耗尽|用尽)|余额不足`)
var credentialText = regexp.MustCompile(`(?:invalid|incorrect|expired|revoked) (?:api key|authentication token|access token)|(?:api key|authentication token|access token) (?:is |has been )?(?:invalid|incorrect|expired|revoked)|api key not valid|(?:api密钥|api 密钥|访问令牌)(?:已)?(?:无效|失效|过期|撤销)`)

// Classify reads only the provider's structured error fields in memory. Generic
// permissions, rate limits, model access and quota-rate errors are not credentials
// or account balance evidence. Neither messages nor provider codes are persisted.
func Classify(status int, code, kind, message string) string {
	if status != 200 && status != 400 && status != 401 && status != 402 && status != 403 && status != 429 {
		return ""
	}
	code, kind = strings.ToLower(strings.TrimSpace(code)), strings.ToLower(strings.TrimSpace(kind))
	if code == "insufficient_quota" || kind == "insufficient_quota" {
		return "funds_exhausted"
	}
	if code == "invalid_api_key" || code == "api_key_invalid" || code == "invalid_x_api_key" ||
		(status == 401 && kind == "authentication_error") {
		return "auth_invalid"
	}
	if len(message) > 4096 {
		return ""
	}
	text := strings.ToLower(message)
	text = strings.Join(strings.Fields(strings.Map(func(char rune) rune {
		if unicode.IsPunct(char) || unicode.IsSymbol(char) {
			return ' '
		}
		return char
	}, text)), " ")
	// Negated or hypothetical statements are too ambiguous for a durable block.
	for _, ambiguous := range []string{"not insufficient", "not exhausted", "not invalid", "not expired", "not revoked", "if your", "may be", "might be", "余额充足", "余额未", "并非", "不是"} {
		if strings.Contains(text, ambiguous) {
			return ""
		}
	}
	if fundsText.MatchString(text) {
		return "funds_exhausted"
	}
	if (status == 200 || status == 400 || status == 401 || status == 403) && credentialText.MatchString(text) {
		return "auth_invalid"
	}
	return ""
}
