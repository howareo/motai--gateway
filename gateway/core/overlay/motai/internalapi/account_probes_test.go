package internalapi

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/controller"
)

func TestBillingProbeResponseCarriesOnlyTheTwoOptionalFieldsAndWalletNever(t *testing.T) {
	value := 0.1
	known := accountProbeResponse("billing", "1022", controller.MotaiAccountObservation{State: "known", Multiplier: &value, UpstreamGroup: "国模"}, time.Unix(0, 0))
	if known["upstream_group"] != "国模" || known["source"] != "management_api" {
		t.Fatalf("known billing response %v", known)
	}
	if _, present := known["error_class"]; present {
		t.Fatal("known response carries an error class")
	}
	failed := accountProbeResponse("billing", "1022", controller.MotaiAccountObservation{State: "unknown", ErrorClass: "group_unresolved"}, time.Unix(0, 0))
	if failed["error_class"] != "group_unresolved" || failed["source"] != "unavailable" || failed["multiplier"] != (*float64)(nil) {
		t.Fatalf("unknown billing response %v", failed)
	}
	if _, present := failed["upstream_group"]; present {
		t.Fatal("failed response carries a group")
	}
	// Empty values are omitted, so a probe without them keeps the previous exact shape.
	plain := accountProbeResponse("billing", "1022", controller.MotaiAccountObservation{State: "unsupported"}, time.Unix(0, 0))
	for _, key := range []string{"error_class", "upstream_group"} {
		if _, present := plain[key]; present {
			t.Fatalf("%s present without a value", key)
		}
	}
	// The wallet contract has neither field, even if the observation was filled in.
	wallet := accountProbeResponse("wallet", "1022", controller.MotaiAccountObservation{State: "unknown", ErrorClass: "unauthorized", UpstreamGroup: "g"}, time.Unix(0, 0))
	for _, key := range []string{"error_class", "upstream_group"} {
		if _, present := wallet[key]; present {
			t.Fatalf("wallet response carries %s", key)
		}
	}
}

func TestAccountProbeResponseWhitelistsOpaqueChannelAndKnownUnknown(t *testing.T) {
	value := 0.0
	for _, state := range []string{"known", "unknown", "unsupported"} {
		for _, kind := range []string{"billing", "wallet"} {
			observation := controller.MotaiAccountObservation{State: state}
			if state == "known" {
				observation.Balance = &value
				observation.Multiplier = &value
			}
			response := accountProbeResponse(kind, "0001", observation, time.Unix(0, 0))
			if response["channel_id"] != "0001" || response["state"] != state {
				t.Fatal("identity/state changed")
			}
			data, err := json.Marshal(response)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(data), "Secret") || strings.Contains(string(data), "error") {
				t.Fatal("non-whitelisted observation")
			}
			if kind == "wallet" {
				if _, ok := response["currency"]; !ok {
					t.Fatal("required nullable currency missing")
				}
			}
		}
	}
}
