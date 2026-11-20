package health

import (
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestRetryAfterLegalValuesAndBounds(t *testing.T) {
	now := time.Date(2026, 10, 27, 7, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name    string
		values  []string
		max     int
		valid   bool
		seconds int
	}{
		{"seconds", []string{"12"}, 3600, true, 12}, {"zero", []string{"0"}, 3600, true, 0},
		{"bounded-seconds", []string{"7200"}, 3600, true, 3600},
		{"http-date", []string{now.Add(45 * time.Second).Format(http.TimeFormat)}, 3600, true, 45},
		{"bounded-date", []string{now.Add(2 * time.Hour).Format(http.TimeFormat)}, 3600, true, 3600},
		{"past-date", []string{now.Add(-time.Second).Format(http.TimeFormat)}, 3600, false, 0},
		{"negative", []string{"-1"}, 3600, false, 0}, {"sign", []string{"+1"}, 3600, false, 0},
		{"fraction", []string{"1.5"}, 3600, false, 0}, {"multiple", []string{"1", "2"}, 3600, false, 0},
		{"combined", []string{"1,2"}, 3600, false, 0}, {"overflow", []string{"999999999999999999999999"}, 3600, false, 0},
		{"empty", nil, 3600, false, 0}, {"no-policy", []string{"1"}, 0, false, 0},
		{"illegal-control", []string{"\r\n1"}, 3600, false, 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			deadline, ok := RetryAfter(test.values, now, test.max)
			require.Equal(t, test.valid, ok)
			if ok {
				require.Equal(t, now.Add(time.Duration(test.seconds)*time.Second), deadline)
			}
		})
	}
}

func TestAccountClassificationRequiresSpecificEvidence(t *testing.T) {
	for _, test := range []struct {
		name                      string
		status                    int
		code, kind, message, want string
	}{
		{"quota-code", 429, "insufficient_quota", "", "CANARY_SECRET", "funds_exhausted"},
		{"balance-text", 403, "", "", "Your account balance is insufficient.", "funds_exhausted"},
		{"credit-text", 400, "", "", "Your credit balance is too low to access the API.", "funds_exhausted"},
		{"chinese-balance", 403, "", "", "账户余额已耗尽，请充值", "funds_exhausted"},
		{"invalid-key-code", 401, "invalid_api_key", "", "CANARY_SECRET", "auth_invalid"},
		{"gemini-key-code", 400, "API_KEY_INVALID", "", "", "auth_invalid"},
		{"claude-auth-type", 401, "", "authentication_error", "", "auth_invalid"},
		{"invalid-key-text", 401, "", "", "Incorrect API key provided.", "auth_invalid"},
		{"revoked-key-text", 403, "", "", "The API key has been revoked.", "auth_invalid"},
		{"semantic-failed-code", 200, "insufficient_quota", "", "", "funds_exhausted"},
		{"generic-401", 401, "", "", "Unauthorized", ""},
		{"generic-403", 403, "", "permission_error", "Access denied for this model", ""},
		{"rate-quota", 429, "rate_limit_exceeded", "", "Quota exhausted for requests per minute", ""},
		{"context-quota", 400, "", "", "Token quota exceeded for context length", ""},
		{"funds-object-without-exhaustion", 403, "", "", "Account balance endpoint permission denied", ""},
		{"hypothetical", 403, "", "", "If your account balance is insufficient, contact support", ""},
		{"negated-balance", 403, "", "", "Account balance is not insufficient", ""},
		{"negated-key", 401, "", "", "API key is not invalid", ""},
		{"upstream-server-error", 500, "invalid_api_key", "", "", ""},
		{"no-upstream-status", 0, "invalid_api_key", "", "", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			require.Equal(t, test.want, Classify(test.status, test.code, test.kind, test.message))
		})
	}
}
