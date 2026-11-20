package store

import (
	"crypto/sha256"
	"encoding/hex"
)

func ChannelHealthLock(pool, channel, ref, version string) string {
	hash := sha256.New()
	for _, value := range []string{"motai-channel-health-v1", pool, channel, ref, version} {
		hash.Write([]byte(value))
		hash.Write([]byte{0})
	}
	return hex.EncodeToString(hash.Sum(nil))
}
