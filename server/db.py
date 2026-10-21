"""Auto Radar — storage.

SQLite on purpose. A few models tracked daily is a dataset measured in
megabytes for years, and the whole thing backs up by copying one file. Postgres
becomes interesting only once this stops being a single-user tool.

The central idea is *change-only* snapshots: a row is written when a price or
mileage actually moves, not on every sighting. Presence is tracked separately
through ``last_seen_at``, which is what makes days-on-market and "ad vanished"
answerable later.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DB_PATH = Path(__file__).with_name("radar.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS listings (
    id              TEXT PRIMARY KEY,          -- "<site>:<external_id>"
    site            TEXT NOT NULL,
    external_id     TEXT NOT NULL,
    url             TEXT,
    title           TEXT,
    brand           TEXT,
    model           TEXT,
    year            INTEGER,
    fuel            TEXT,
    transmission    TEXT,
    body            TEXT,
    engine_ccm      INTEGER,
    engine_kw       INTEGER,
    drivetrain      TEXT,
    color           TEXT,
    vin             TEXT,
    posted_at_raw   TEXT,
    first_seen_at   TEXT NOT NULL,
    last_seen_at    TEXT NOT NULL,
    seen_count      INTEGER NOT NULL DEFAULT 1,
    gone_since      TEXT                        -- set by a later sweep, not on ingest
);

CREATE TABLE IF NOT EXISTS snapshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id  TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    seen_at     TEXT NOT NULL,
    price       INTEGER,
    currency    TEXT,
    mileage     INTEGER,
    on_request  INTEGER NOT NULL DEFAULT 0,
    source      TEXT,                           -- search | detail
    via         TEXT                            -- which extraction rung fired
);

CREATE INDEX IF NOT EXISTS idx_snapshots_listing ON snapshots(listing_id, seen_at);
CREATE INDEX IF NOT EXISTS idx_listings_model    ON listings(brand, model, year);
CREATE INDEX IF NOT EXISTS idx_listings_seen     ON listings(last_seen_at);

-- Kept deliberately small: enough to debug a parser regression, not an archive.
CREATE TABLE IF NOT EXISTS ingest_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at TEXT NOT NULL,
    url         TEXT,
    page_type   TEXT,
    n_listings  INTEGER,
    n_new       INTEGER,
    n_changed   INTEGER
);
"""

LISTING_FIELDS = (
    "url", "title", "brand", "model", "year", "fuel", "transmission", "body",
    "engine_ccm", "engine_kw", "drivetrain", "color", "vin", "posted_at_raw",
)


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect(path: Path = DB_PATH) -> sqlite3.Connection:
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")      # concurrent reads while ingesting
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA)
    return conn


def _as_int(value: Any) -> int | None:
    try:
        if value is None or value == "":
            return None
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _clean(rec: dict) -> dict:
    """Normalise one extracted record into column shapes."""
    out = {k: rec.get(k) for k in LISTING_FIELDS}
    for k in ("year", "engine_ccm", "engine_kw"):
        out[k] = _as_int(out[k])
    for k, v in list(out.items()):
        if isinstance(v, str):
            v = v.strip()
            out[k] = v or None
    return out


def ingest(conn: sqlite3.Connection, payload: dict) -> dict:
    """Apply one page scan. Returns counters for the response and the log."""
    site = payload.get("site") or "unknown"
    source = payload.get("page_type")
    seen_at = payload.get("scanned_at") or now()
    listings = payload.get("listings") or []

    new_count = changed_count = 0

    with conn:  # one transaction per page scan
        for rec in listings:
            external_id = str(rec.get("external_id") or "").strip()
            if not external_id:
                continue

            lid = f"{site}:{external_id}"
            fields = _clean(rec)
            price = _as_int(rec.get("price"))
            mileage = _as_int(rec.get("mileage"))
            on_request = 1 if rec.get("on_request") else 0
            currency = rec.get("currency") or ("EUR" if price else None)

            existing = conn.execute(
                "SELECT id FROM listings WHERE id = ?", (lid,)
            ).fetchone()

            if existing is None:
                cols = ", ".join(LISTING_FIELDS)
                marks = ", ".join("?" for _ in LISTING_FIELDS)
                conn.execute(
                    f"""INSERT INTO listings (id, site, external_id, {cols},
                                              first_seen_at, last_seen_at, seen_count)
                        VALUES (?, ?, ?, {marks}, ?, ?, 1)""",
                    (lid, site, external_id, *[fields[k] for k in LISTING_FIELDS], seen_at, seen_at),
                )
                new_count += 1
            else:
                # Search cards are sparse; a later detail view fills the gaps.
                # COALESCE keeps whichever source actually knew the value.
                sets = ", ".join(f"{k} = COALESCE(?, {k})" for k in LISTING_FIELDS)
                conn.execute(
                    f"""UPDATE listings
                           SET {sets},
                               last_seen_at = ?,
                               seen_count = seen_count + 1,
                               gone_since = NULL
                         WHERE id = ?""",
                    (*[fields[k] for k in LISTING_FIELDS], seen_at, lid),
                )

            last = conn.execute(
                """SELECT price, mileage, on_request FROM snapshots
                    WHERE listing_id = ? ORDER BY seen_at DESC, id DESC LIMIT 1""",
                (lid,),
            ).fetchone()

            unchanged = (
                last is not None
                and last["price"] == price
                and last["mileage"] == mileage
                and last["on_request"] == on_request
            )
            if unchanged:
                continue

            conn.execute(
                """INSERT INTO snapshots
                       (listing_id, seen_at, price, currency, mileage, on_request, source, via)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (lid, seen_at, price, currency, mileage, on_request, source, rec.get("via")),
            )
            if last is not None:
                changed_count += 1

        conn.execute(
            """INSERT INTO ingest_log (received_at, url, page_type, n_listings, n_new, n_changed)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (now(), payload.get("url"), source, len(listings), new_count, changed_count),
        )
        conn.execute(
            "DELETE FROM ingest_log WHERE id <= (SELECT MAX(id) - 500 FROM ingest_log)"
        )

    return {"received": len(listings), "new": new_count, "changed": changed_count}


def summary(conn: sqlite3.Connection) -> dict:
    one = lambda sql: conn.execute(sql).fetchone()[0]  # noqa: E731
    return {
        "listings": one("SELECT COUNT(*) FROM listings"),
        "snapshots": one("SELECT COUNT(*) FROM snapshots"),
        "price_changes": one(
            """SELECT COUNT(*) FROM (
                   SELECT listing_id FROM snapshots
                    GROUP BY listing_id HAVING COUNT(*) > 1
               )"""
        ),
        "models": one("SELECT COUNT(DISTINCT brand || ' ' || model) FROM listings WHERE brand IS NOT NULL"),
        "first_seen": one("SELECT MIN(first_seen_at) FROM listings"),
        "last_seen": one("SELECT MAX(last_seen_at) FROM listings"),
    }


def price_drops(conn: sqlite3.Connection, limit: int = 50) -> list[dict]:
    """Listings whose newest price is below their previous one."""
    rows = conn.execute(
        """
        WITH ranked AS (
            SELECT listing_id, price, seen_at,
                   ROW_NUMBER() OVER (PARTITION BY listing_id ORDER BY seen_at DESC, id DESC) AS rn
              FROM snapshots
             WHERE price IS NOT NULL
        )
        SELECT l.id, l.title, l.url, l.year, l.brand, l.model,
               curr.price AS price_now, prev.price AS price_before,
               curr.seen_at AS changed_at,
               l.first_seen_at,
               CAST(julianday(curr.seen_at) - julianday(l.first_seen_at) AS INTEGER) AS days_tracked
          FROM ranked curr
          JOIN ranked prev ON prev.listing_id = curr.listing_id AND prev.rn = 2
          JOIN listings l  ON l.id = curr.listing_id
         WHERE curr.rn = 1 AND curr.price < prev.price
         ORDER BY curr.seen_at DESC
         LIMIT ?
        """,
        (limit,),
    ).fetchall()
    return [dict(r) | {"drop_pct": round(100 * (1 - r["price_now"] / r["price_before"]), 1)} for r in rows]


def listings(
    conn: sqlite3.Connection,
    limit: int = 200,
    brand: str | None = None,
    model: str | None = None,
) -> list[dict]:
    sql = """
        SELECT l.*, s.price AS price_now, s.mileage AS mileage_now, s.currency,
               (SELECT COUNT(*) FROM snapshots x WHERE x.listing_id = l.id) AS snapshot_count,
               CAST(julianday('now') - julianday(l.first_seen_at) AS INTEGER) AS days_tracked
          FROM listings l
          LEFT JOIN snapshots s ON s.id = (
                SELECT id FROM snapshots y WHERE y.listing_id = l.id
                 ORDER BY seen_at DESC, id DESC LIMIT 1)
    """
    where: list[str] = []
    params: list[Any] = []
    if brand:
        where.append("LOWER(l.brand) = LOWER(?)")
        params.append(brand)
    if model:
        where.append("LOWER(l.model) = LOWER(?)")
        params.append(model)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY l.last_seen_at DESC LIMIT ?"
    params.append(limit)
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


def models(conn: sqlite3.Connection) -> list[dict]:
    """One row per brand+model, for the dashboard's picker.

    Ads whose brand never got filled in (search cards are sparse until you open
    the detail page) are grouped under a NULL model rather than dropped — they
    still carry price history worth seeing.
    """
    rows = conn.execute(
        """
        SELECT l.brand, l.model, COUNT(*) AS n,
               SUM(CASE WHEN s.price IS NOT NULL THEN 1 ELSE 0 END) AS n_priced,
               CAST(AVG(s.price) AS INTEGER) AS avg_price,
               MIN(s.price) AS min_price,
               MAX(s.price) AS max_price
          FROM listings l
          LEFT JOIN snapshots s ON s.id = (
                SELECT id FROM snapshots y WHERE y.listing_id = l.id
                 ORDER BY seen_at DESC, id DESC LIMIT 1)
         GROUP BY LOWER(COALESCE(l.brand,'')), LOWER(COALESCE(l.model,''))
         ORDER BY n DESC
        """
    ).fetchall()
    return [dict(r) for r in rows]


def history(conn: sqlite3.Connection, listing_id: str) -> dict:
    row = conn.execute("SELECT * FROM listings WHERE id = ?", (listing_id,)).fetchone()
    if row is None:
        return {}
    snaps = conn.execute(
        "SELECT seen_at, price, currency, mileage, on_request, source FROM snapshots "
        "WHERE listing_id = ? ORDER BY seen_at",
        (listing_id,),
    ).fetchall()
    return {"listing": dict(row), "snapshots": [dict(s) for s in snaps]}
