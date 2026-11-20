package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/controller"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/motai/attempt"
	"github.com/QuantumNous/new-api/motai/configview"
	"github.com/QuantumNous/new-api/motai/contract"
	"github.com/QuantumNous/new-api/motai/internalapi"
	"github.com/QuantumNous/new-api/motai/store"
	kitutil "github.com/QuantumNous/new-api/relaykit/relayconvert/kitutil"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
	"github.com/gin-gonic/gin"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "motai candidate initialization failed")
		os.Exit(1)
	}
}

func secretFile(name string) ([]byte, error) {
	path := os.Getenv(name)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return nil, fmt.Errorf("invalid private key file")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(data) < 32 || len(data) > 4096 {
		return nil, fmt.Errorf("invalid private key length")
	}
	return data, nil
}

func managementToken(data []byte) (string, error) {
	token := strings.TrimRight(string(data), "\r\n")
	if len(token) < 32 || strings.ContainsAny(token, "\r\n") {
		return "", fmt.Errorf("invalid management key")
	}
	return token, nil
}

func motaiHealth(snapshot func() *configview.View, draining *atomic.Bool, accepting func() bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		if draining.Load() {
			c.JSON(http.StatusServiceUnavailable, gin.H{"ok": false, "draining": true, "mode": "motai_nocharge_candidate", "version": common.Version})
			return
		}
		ready := accepting() && snapshot() != nil
		status := http.StatusOK
		if !ready {
			status = http.StatusServiceUnavailable
		}
		c.JSON(status, gin.H{"ok": ready, "mode": "motai_nocharge_candidate", "version": common.Version})
	}
}

func run() error {
	if len(os.Args) != 1 {
		return fmt.Errorf("runtime accepts no migration commands")
	}
	if err := os.Setenv("MOTAI_GATEWAY_NO_CHARGE", "1"); err != nil {
		return err
	}
	common.InitEnv()
	common.IsMasterNode = false
	common.RedisEnabled = false
	common.MemoryCacheEnabled = false
	common.BatchUpdateEnabled = false
	logger.SetupLogger()
	kitutil.SetLogging(common.SysLog, func(message string) { logger.LogError(nil, message) })
	kitutil.SetSystemErrorLogging(common.SysError)
	ratio_setting.InitRatioSettings()
	service.InitHttpClient()
	service.InitTokenEncoders()
	if err := i18n.Init(); err != nil {
		return err
	}
	key, err := secretFile("MOTAI_HMAC_KEY_FILE")
	if err != nil {
		return err
	}
	management, err := secretFile("MOTAI_MANAGEMENT_KEY_FILE")
	if err != nil {
		return err
	}
	managementCredential, err := managementToken(management)
	if err != nil {
		return err
	}
	validator, err := contract.NewValidator(filepath.Join(os.Getenv("MOTAI_CONTRACTS_DIR"), "v1"))
	if err != nil {
		return err
	}
	database, err := store.Open(os.Getenv("MOTAI_RUNTIME_DSN"), os.Getenv("MOTAI_ACTIVATOR_DSN"))
	if err != nil {
		return err
	}
	defer database.Close()
	forbidden := []string{}
	for _, target := range strings.Split(os.Getenv("MOTAI_FORBIDDEN_TARGETS"), ",") {
		if target = strings.TrimSpace(target); target != "" {
			forbidden = append(forbidden, target)
		}
	}
	manager := &configview.Manager{Directory: os.Getenv("MOTAI_CONFIG_DIR"), Validator: validator, Store: database, Forbidden: forbidden}
	recoverContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	err = manager.Recover(recoverContext)
	cancel()
	if err != nil {
		common.SysLog("motai committed configuration is not ready")
	}
	runtime, err := attempt.New(context.Background(), database, validator, key, 256)
	if err != nil {
		return err
	}
	defer runtime.Close()
	gin.SetMode(gin.ReleaseMode)
	engine := gin.New()
	engine.Use(gin.Recovery(), middleware.RequestId(), middleware.Version(), middleware.I18n(), middleware.CORS(), middleware.DecompressRequestMiddleware(), middleware.BodyStorageCleanup())
	if err = middleware.ConfigureTrustedProxies(engine); err != nil {
		return err
	}
	var draining atomic.Bool
	engine.GET("/healthz", motaiHealth(manager.Snapshot, &draining, runtime.Accepting))
	engine.GET("/v1/models", middleware.MotaiModels(manager.Snapshot, key))
	for _, route := range []struct {
		Path     string
		Protocol string
		Format   types.RelayFormat
	}{
		{"/v1/responses", "responses", types.RelayFormatOpenAIResponses},
		{"/v1/responses/compact", "responses", types.RelayFormatOpenAIResponsesCompaction},
		{"/v1/chat/completions", "chat_completions", types.RelayFormatOpenAI},
		{"/v1/messages", "messages", types.RelayFormatClaude},
		{"/v1beta/models/*path", "gemini_generate_content", types.RelayFormatGemini},
	} {
		engine.POST(route.Path, middleware.MotaiView(manager, runtime, key, route.Protocol), func(c *gin.Context) { controller.Relay(c, route.Format) })
	}
	engine.POST("/v1/messages/count_tokens", middleware.MotaiView(manager, runtime, key, "count_tokens"), controller.CountClaudeTokens)
	port := os.Getenv("PORT")
	if port == "" {
		port = "3001"
	}
	internalAddr := os.Getenv("MOTAI_INTERNAL_ADDR")
	if internalAddr == "" {
		internalAddr = "127.0.0.1:3002"
	}
	servers := []*http.Server{{Addr: ":" + port, Handler: engine}, {Addr: internalAddr, Handler: internalapi.Handler(manager, runtime, managementCredential, common.Version, engine)}}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(signals)
	errors := make(chan error, len(servers))
	for _, server := range servers {
		go func() { errors <- server.ListenAndServe() }()
	}
	for {
		select {
		case <-signals:
			draining.Store(true)
			runtime.SetAccepting(false)
			deadline := time.Now().Add(15 * time.Minute)
			for time.Now().Before(deadline) {
				live := runtime.Status(context.Background())
				if live["in_flight"].(int64) == 0 && live["completion_pending"].(int64) == 0 {
					goto drained
				}
				time.Sleep(100 * time.Millisecond)
			}
			common.SysLog("motai drain timed out; process remains available for recovery")
			runtime.SetAccepting(true)
			draining.Store(false)
		case err = <-errors:
			if err != http.ErrServerClosed {
				return err
			}
			return nil
		}
	}
drained:
	shutdown, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	for _, server := range servers {
		if err = server.Shutdown(shutdown); err != nil {
			return err
		}
	}
	return nil
}
