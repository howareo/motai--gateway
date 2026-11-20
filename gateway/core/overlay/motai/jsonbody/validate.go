// Package jsonbody rejects ambiguous client JSON before routing or forwarding.
package jsonbody

import (
	"encoding/json"
	"errors"
	"io"
	"strings"
	"unicode"
)

var errInvalid = errors.New("invalid or ambiguous JSON")

// Validate scans without retaining prompt values or rewriting the request body.
func Validate(reader io.Reader) error {
	decoder := json.NewDecoder(reader)
	decoder.UseNumber()
	if err := readValue(decoder, true, 0); err != nil {
		return errInvalid
	}
	if _, err := decoder.Token(); err != io.EOF {
		return errInvalid
	}
	return nil
}

func readValue(decoder *json.Decoder, fold bool, depth int) error {
	token, err := decoder.Token()
	if err != nil || depth > 10000 {
		return errInvalid
	}
	delim, container := token.(json.Delim)
	if depth == 0 && (!container || delim != '{') {
		return errInvalid
	}
	if !container {
		return nil
	}
	if delim != '{' && delim != '[' {
		return errInvalid
	}
	seen := map[string]bool{}
	for decoder.More() {
		childFold := fold
		if delim == '{' {
			token, err := decoder.Token()
			if err != nil {
				return errInvalid
			}
			key, ok := token.(string)
			if !ok {
				return errInvalid
			}
			canonical := key
			if fold {
				canonical = strings.Map(foldRune, key)
			}
			if seen[canonical] {
				return errInvalid
			}
			seen[canonical] = true
			// User-defined tool/schema keys are case sensitive, unlike DTO fields.
			switch strings.ToLower(key) {
			case "properties", "patternproperties", "$defs", "definitions", "dependentschemas", "dependentrequired", "dependencies", "default", "const", "examples", "enum", "args", "arguments", "variables", "headers", "labels":
				childFold = false
			case "input", "response":
				if depth > 0 {
					childFold = false
				}
			}
		}
		if err := readValue(decoder, childFold, depth+1); err != nil {
			return err
		}
	}
	end, err := decoder.Token()
	if err != nil || (delim == '{' && end != json.Delim('}')) || (delim == '[' && end != json.Delim(']')) {
		return errInvalid
	}
	return nil
}

func foldRune(value rune) rune {
	minimum := value
	for next := unicode.SimpleFold(value); next != value; next = unicode.SimpleFold(next) {
		if next < minimum {
			minimum = next
		}
	}
	return minimum
}
