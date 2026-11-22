package openai

import (
	"bytes"
	"io"
	"net/http"

	"github.com/QuantumNous/new-api/relay/channel"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/gin-gonic/gin"
)

type geminiResponseBody struct {
	*io.PipeReader
	source io.ReadCloser
}

func (body *geminiResponseBody) Close() error {
	err := body.source.Close()
	_ = body.PipeReader.Close()
	return err
}

func (a *Adaptor) doGeminiResponsesRequest(c *gin.Context, info *relaycommon.RelayInfo, reader io.Reader) (any, error) {
	data, err := io.ReadAll(reader)
	if err != nil {
		return nil, err
	}
	data, compat, err := prepareGeminiResponses(data)
	if err != nil {
		return nil, err
	}
	response, err := channel.DoApiRequest(a, c, info, bytes.NewReader(data))
	if err != nil {
		return response, err
	}
	if response == nil || response.StatusCode != http.StatusOK || compat == nil || len(compat.routes) == 0 {
		return response, nil
	}
	source := response.Body
	stream := info.IsStream
	output, writer := io.Pipe()
	response.Body = &geminiResponseBody{PipeReader: output, source: source}
	response.ContentLength = -1
	response.Header.Del("Content-Length")
	go func() { defer source.Close(); _ = writer.CloseWithError(compat.rewrite(source, writer, stream)) }()
	return response, nil
}
