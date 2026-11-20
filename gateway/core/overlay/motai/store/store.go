package store

import (
	"context"
	"database/sql"
	"errors"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

type Store struct {
	Runtime   *sql.DB
	Activator *sql.DB
}

func Open(runtimeDSN, activatorDSN string) (*Store, error) {
	runtime, err := sql.Open("pgx", runtimeDSN)
	if err != nil {
		return nil, err
	}
	activator, err := sql.Open("pgx", activatorDSN)
	if err != nil {
		runtime.Close()
		return nil, err
	}
	for _, db := range []*sql.DB{runtime, activator} {
		db.SetMaxOpenConns(8)
		db.SetMaxIdleConns(2)
		db.SetConnMaxLifetime(5 * time.Minute)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err = runtime.PingContext(ctx); err == nil {
		err = activator.PingContext(ctx)
	}
	if err != nil {
		runtime.Close()
		activator.Close()
		return nil, err
	}
	return &Store{runtime, activator}, nil
}

func (s *Store) Close() { s.Runtime.Close(); s.Activator.Close() }

type Committed struct {
	Gen            string
	ManifestFile   string
	ManifestSHA256 string
	LKG            *string
}

func (s *Store) ReadCommitted(ctx context.Context) (*Committed, error) {
	var value Committed
	err := s.Runtime.QueryRowContext(ctx, `SELECT g.gen,g.manifest_file,g.manifest_sha256,s.lkg_gen
		FROM motai.gateway_state s JOIN motai.config_generations g ON g.gen=s.committed_gen WHERE s.singleton=1`).Scan(
		&value.Gen, &value.ManifestFile, &value.ManifestSHA256, &value.LKG)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &value, err
}

func (s *Store) Epochs(ctx context.Context) (map[string]string, error) {
	rows, err := s.Runtime.QueryContext(ctx, `SELECT pool_id,epoch::text FROM motai.pool_state`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string]string{}
	for rows.Next() {
		var id, epoch string
		if err = rows.Scan(&id, &epoch); err != nil {
			return nil, err
		}
		result[id] = epoch
	}
	return result, rows.Err()
}

func (s *Store) Activate(ctx context.Context, gen, manifestFile, manifestHash string, base *string, fingerprints map[string]string) (map[string]string, error) {
	tx, err := s.Activator.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `SET LOCAL synchronous_commit=on`); err != nil {
		return nil, err
	}
	var current *string
	if err = tx.QueryRowContext(ctx, `SELECT committed_gen FROM motai.gateway_state WHERE singleton=1 FOR UPDATE`).Scan(&current); err != nil {
		return nil, err
	}
	if current != nil && *current == gen {
		var hash string
		if err = tx.QueryRowContext(ctx, `SELECT manifest_sha256 FROM motai.config_generations WHERE gen=$1`, gen).Scan(&hash); err != nil {
			return nil, err
		}
		if hash != manifestHash {
			return nil, errors.New("generation_conflict")
		}
	} else {
		if (current == nil) != (base == nil) || (current != nil && *current != *base) {
			return nil, errors.New("stale_base_generation")
		}
		var existing string
		err = tx.QueryRowContext(ctx, `SELECT manifest_sha256 FROM motai.config_generations WHERE gen=$1`, gen).Scan(&existing)
		if err == nil {
			return nil, errors.New("generation_conflict")
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO motai.config_generations(gen,manifest_file,manifest_sha256) VALUES($1,$2,$3)`, gen, manifestFile, manifestHash); err != nil {
			return nil, err
		}
		poolIDs := make([]string, 0, len(fingerprints))
		for id := range fingerprints {
			poolIDs = append(poolIDs, id)
		}
		if _, err = tx.ExecContext(ctx, `UPDATE motai.pool_state SET active=false,epoch=epoch+1 WHERE active AND NOT(pool_id=ANY($1::text[]))`, poolIDs); err != nil {
			return nil, err
		}
		for id, fingerprint := range fingerprints {
			if _, err = tx.ExecContext(ctx, `INSERT INTO motai.pool_state(pool_id,epoch,routing_fingerprint) VALUES($1,1,$2)
				ON CONFLICT(pool_id) DO UPDATE SET epoch=CASE WHEN motai.pool_state.active AND motai.pool_state.routing_fingerprint=excluded.routing_fingerprint THEN motai.pool_state.epoch ELSE motai.pool_state.epoch+1 END,routing_fingerprint=excluded.routing_fingerprint,active=true`, id, fingerprint); err != nil {
				return nil, err
			}
		}
		if _, err = tx.ExecContext(ctx, `UPDATE motai.gateway_state SET lkg_gen=committed_gen,committed_gen=$1 WHERE singleton=1`, gen); err != nil {
			return nil, err
		}
	}
	rows, err := tx.QueryContext(ctx, `SELECT pool_id,epoch::text FROM motai.pool_state`)
	if err != nil {
		return nil, err
	}
	epochs := map[string]string{}
	for rows.Next() {
		var id, epoch string
		if err = rows.Scan(&id, &epoch); err != nil {
			rows.Close()
			return nil, err
		}
		epochs[id] = epoch
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return epochs, nil
}
