"""Smoke test: three days of browsing against a running collector."""
import json, sys, urllib.request

BASE, TOKEN = sys.argv[1], sys.argv[2]


def call(method, path, body=None):
    req = urllib.request.Request(
        BASE + path, method=method,
        data=json.dumps(body).encode() if body else None,
        headers={"Content-Type": "application/json", "X-Radar-Token": TOKEN},
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def search(day, listings):
    return {"site": "polovniautomobili.com", "page_type": "search",
            "url": "https://www.polovniautomobili.com/auto-oglasi/pretraga?brand=volkswagen",
            "scanned_at": f"2026-10-{day:02d}T09:00:00+00:00", "listings": listings}


ok = True
def check(label, got, want):
    global ok
    good = got == want
    ok = ok and good
    print(f"  {'PASS' if good else 'FAIL'}  {label}: {got}" + ("" if good else f"  (ocekivano {want})"))


print("\nDan 1 — prvi put vidim 3 oglasa")
r = call("POST", "/ingest", search(18, [
    {"external_id": "101", "title": "VW Golf 7 1.6 TDI", "price": 14500, "currency": "EUR",
     "mileage": 180000, "year": 2015, "via": "search-card",
     "url": "https://www.polovniautomobili.com/auto-oglasi/101/golf-7"},
    {"external_id": "102", "title": "VW Golf 7 2.0 TDI", "price": 16900, "currency": "EUR",
     "mileage": 150000, "year": 2016, "via": "search-card"},
    {"external_id": "103", "title": "VW Golf 7 GTI", "price": None, "on_request": True,
     "mileage": 90000, "year": 2017, "via": "search-card"},
]))
check("novih", r["new"], 3); check("promena", r["changed"], 0)

print("\nDan 2 — ista pretraga, nista se nije promenilo")
r = call("POST", "/ingest", search(19, [
    {"external_id": "101", "price": 14500, "mileage": 180000, "via": "search-card"},
    {"external_id": "102", "price": 16900, "mileage": 150000, "via": "search-card"},
]))
check("novih", r["new"], 0)
check("promena (ne sme da duplira)", r["changed"], 0)

print("\nDan 3 — oglas 101 snizen, 102 dodao kilometrazu")
r = call("POST", "/ingest", search(20, [
    {"external_id": "101", "price": 13200, "mileage": 180000, "via": "search-card"},
    {"external_id": "102", "price": 16900, "mileage": 151200, "via": "search-card"},
]))
check("promena cene/km", r["changed"], 2)

print("\nDan 3 — otvaram detaljnu stranicu 101 (dopuna polja)")
r = call("POST", "/ingest", {
    "site": "polovniautomobili.com", "page_type": "detail",
    "scanned_at": "2026-10-20T10:00:00+00:00",
    "listings": [{"external_id": "101", "price": 13200, "mileage": 180000,
                  "brand": "Volkswagen", "model": "Golf 7", "fuel": "Dizel",
                  "transmission": "Manuelni 6 brzina", "engine_kw": 81,
                  "engine_ccm": 1598, "via": "json-ld"}],
})
check("bez novih", r["new"], 0)
check("cena ista -> nema snimka", r["changed"], 0)

print("\nProvere stanja")
s = call("GET", "/api/summary")
check("ukupno oglasa", s["listings"], 3)
check("ukupno snimaka", s["snapshots"], 5)   # 3 pocetna + 2 promene
check("sa promenom cene", s["price_changes"], 2)

drops = call("GET", "/api/drops")
check("padova cene", len(drops), 1)
check("procenat pada", drops[0]["drop_pct"], 9.0)
check("dana pracenja", drops[0]["days_tracked"], 2)

h = call("GET", "/api/history/polovniautomobili.com:101")
check("istorija 101", [x["price"] for x in h["snapshots"]], [14500, 13200])
check("detalji popunjeni", h["listing"]["fuel"], "Dizel")
check("naslov iz search-a sacuvan", h["listing"]["title"], "VW Golf 7 1.6 TDI")

lst = call("GET", "/api/listings")
by_id = {x["external_id"]: x for x in lst}
check("103 cena na upit", by_id["103"]["price_now"], None)

print("\n" + ("SVE PROLAZI" if ok else "IMA PADOVA"))
sys.exit(0 if ok else 1)
