package store

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"sort"
)

//go:embed migrations/*.sql
var migrations embed.FS

func Migrate(ctx context.Context, db *sql.DB) error {
	entries, err := migrations.ReadDir("migrations")
	if err != nil {
		return err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, entry := range entries {
		data, err := migrations.ReadFile("migrations/" + entry.Name())
		if err != nil {
			return err
		}
		var version int
		if _, err = fmt.Sscanf(entry.Name(), "%d-", &version); err != nil {
			return err
		}
		var exists bool
		if err = db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema='motai' AND table_name='schema_migrations')`).Scan(&exists); err != nil {
			return err
		}
		if exists {
			var applied bool
			if err = db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM motai.schema_migrations WHERE version=$1)`, version).Scan(&applied); err != nil {
				return err
			}
			if applied {
				continue
			}
		}
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, string(data)); err != nil {
			tx.Rollback()
			return err
		}
		if err = tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}
