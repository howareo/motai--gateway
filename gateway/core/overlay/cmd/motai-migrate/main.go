package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"time"

	"github.com/QuantumNous/new-api/motai/store"
	_ "github.com/jackc/pgx/v5/stdlib"
)

func main() {
	if err := migrate(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func migrate() error {
	if len(os.Args) != 2 || os.Args[1] != "up" {
		return fmt.Errorf("explicit migration command required: up")
	}
	db, err := sql.Open("pgx", os.Getenv("MOTAI_OWNER_DSN"))
	if err != nil {
		return err
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return store.Migrate(ctx, db)
}
