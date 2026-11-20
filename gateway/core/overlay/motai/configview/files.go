package configview

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/motai/contract"
)

type FileRef struct {
	File   string `json:"file"`
	SHA256 string `json:"sha256"`
}
type Manifest struct {
	FormatVersion int     `json:"format_version"`
	Gen           string  `json:"gen"`
	BaseGen       *string `json:"base_gen"`
	Config        FileRef `json:"config"`
	Credentials   FileRef `json:"credentials"`
}
type Pointer struct {
	FormatVersion int     `json:"format_version"`
	Gen           string  `json:"gen"`
	Manifest      FileRef `json:"manifest"`
}

func readFile(directory string, ref FileRef, private bool) ([]byte, error) {
	if filepath.Base(ref.File) != ref.File || ref.File == "." {
		return nil, errors.New("invalid file reference")
	}
	path := filepath.Join(directory, ref.File)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || (private && info.Mode().Perm()&0077 != 0) {
		return nil, errors.New("invalid file permissions")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	hash := sha256.Sum256(data)
	if hex.EncodeToString(hash[:]) != ref.SHA256 {
		return nil, errors.New("file hash mismatch")
	}
	return data, nil
}

func Load(directory string, ref FileRef, validator *contract.Validator, forbidden []string) (*View, Manifest, error) {
	data, err := readFile(directory, ref, true)
	if err != nil {
		return nil, Manifest{}, err
	}
	if err = validator.Validate("manifest", data); err != nil {
		return nil, Manifest{}, err
	}
	var manifest Manifest
	if err = common.Unmarshal(data, &manifest); err != nil {
		return nil, manifest, err
	}
	configBytes, err := readFile(directory, manifest.Config, true)
	if err != nil {
		return nil, manifest, err
	}
	secretBytes, err := readFile(directory, manifest.Credentials, true)
	if err != nil {
		return nil, manifest, err
	}
	if err = validator.ValidateConfig(configBytes, secretBytes, forbidden); err != nil {
		return nil, manifest, err
	}
	var config Config
	var credentials Credentials
	if err = common.Unmarshal(configBytes, &config); err != nil {
		return nil, manifest, err
	}
	if err = common.Unmarshal(secretBytes, &credentials); err != nil {
		return nil, manifest, err
	}
	if config.Gen != manifest.Gen || credentials.Gen != config.Gen {
		return nil, manifest, errors.New("generation mismatch")
	}
	for i := range config.Channels {
		channel := &config.Channels[i]
		if channel.CredentialRef == nil || channel.CredentialVersion == nil {
			continue
		}
		for _, entry := range credentials.Entries {
			if entry.Ref == *channel.CredentialRef && entry.Version == *channel.CredentialVersion {
				channel.Secret = entry.Secret
				break
			}
		}
	}
	return &View{Config: config, Manifest: ref, Epochs: map[string]string{}}, manifest, nil
}

func ReadDesired(directory string, validator *contract.Validator) (Pointer, error) {
	var pointer Pointer
	path := filepath.Join(directory, "desired.json")
	info, err := os.Lstat(path)
	if err != nil {
		return pointer, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return pointer, errors.New("desired pointer unavailable")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return pointer, err
	}
	if err = validator.Validate("desired_pointer", data); err != nil {
		return pointer, err
	}
	err = common.Unmarshal(data, &pointer)
	return pointer, err
}
