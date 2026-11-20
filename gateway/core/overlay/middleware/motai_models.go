package middleware

import (
	"net/http"
	"sort"
	"time"

	"github.com/QuantumNous/new-api/motai/configview"
	"github.com/gin-gonic/gin"
)

type motaiPublicModel struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	Created int64  `json:"created"`
	OwnedBy string `json:"owned_by"`
}

// MotaiModels lists configured reachability, not current upstream health or billing eligibility.
// It takes one immutable snapshot and never creates an attempt or contacts an upstream.
func MotaiModels(snapshot func() *configview.View, hmacKey []byte) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		view := snapshot()
		if view == nil {
			motaiError(c, http.StatusServiceUnavailable, "gateway_not_ready")
			return
		}
		caller, err := view.Authenticate(hmacKey, motaiToken(c), c.ClientIP(), time.Now())
		if err != nil {
			motaiError(c, http.StatusUnauthorized, "permission_denied")
			return
		}
		names := make(map[string]struct{}, len(view.Config.Models)+len(view.Config.Aliases))
		for _, model := range view.Config.Models {
			names[model.ID] = struct{}{}
		}
		for _, alias := range view.Config.Aliases {
			names[alias.Alias] = struct{}{}
		}
		ids := make([]string, 0, len(names))
		for name := range names {
			for _, protocol := range []string{"responses", "chat_completions", "messages", "gemini_generate_content"} {
				// No request-body group exists on this endpoint. Restricted groups
				// therefore remain hidden unless Candidates permits the empty group.
				if _, err := view.Candidates(caller, name, protocol, c.GetHeader("X-Motai-Pool"), ""); err == nil {
					ids = append(ids, name)
					break
				}
			}
		}
		sort.Strings(ids)
		data := make([]motaiPublicModel, 0, len(ids))
		for _, id := range ids {
			// The local directory has no provider creation timestamp.
			data = append(data, motaiPublicModel{ID: id, Object: "model", Created: 0, OwnedBy: "motai"})
		}
		c.JSON(http.StatusOK, gin.H{"object": "list", "data": data})
	}
}
