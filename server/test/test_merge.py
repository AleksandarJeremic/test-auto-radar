"""Regression test for the bug found on the live site: a sparse search card
must never erase a price that a detail page already established."""
import json, sys, urllib.request

BASE, TOKEN = sys.argv[1], sys.argv[2]
ok = True


def call(method, path, body=None):
    req = urllib.request.Request(
        BASE + path, method=method,
        data=json.dumps(body).encode() if body else None,
        headers={"Content-Type": "application/json", "X-Radar-Token": TOKEN})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def check(label, got, want):
    global ok
    good = got == want
    ok = ok and good
    print(f"  {'PASS' if good else 'FAIL'}  {label}: {got}" + ("" if good else f"  (ocekivano {want})"))


def send(listings, when, page_type="search"):
    return call("POST", "/ingest", {
        "site": "polovniautomobili.com", "page_type": page_type,
        "url": "https://www.polovniautomobili.com/x",
        "scanned_at": when, "listings": listings})


print("\n1. Detaljna stranica postavi cenu, pa kartica stigne bez cene")
send([{"external_id": "500", "title": "Hyundai Tucson", "brand": "Hyundai", "model": "Tucson",
       "price": 25990, "currency": "EUR", "mileage": 5, "via": "framework-state"}],
     "2026-10-21T10:00:00+00:00", "detail")
r = send([{"external_id": "500", "title": "Hyundai Tucson", "price": None, "mileage": None,
           "via": "search-card"}], "2026-10-21T10:05:00+00:00")
check("kartica bez cene ne pravi promenu", r["changed"], 0)
h = call("GET", "/api/history/polovniautomobili.com:500")
check("ostao jedan snimak", len(h["snapshots"]), 1)
check("cena sacuvana", h["snapshots"][-1]["price"], 25990)
check("kilometraza sacuvana", h["snapshots"][-1]["mileage"], 5)

print("\n2. Prava promena cene i dalje prolazi")
r = send([{"external_id": "500", "price": 24500, "currency": "EUR", "mileage": 120,
           "via": "search-card"}], "2026-10-22T10:00:00+00:00")
check("promena zabelezena", r["changed"], 1)
h = call("GET", "/api/history/polovniautomobili.com:500")
check("istorija cena", [s["price"] for s in h["snapshots"]], [25990, 24500])

print("\n3. Prelazak na 'po dogovoru' je prava informacija, ne rupa")
r = send([{"external_id": "500", "price": None, "on_request": True, "via": "search-card"}],
         "2026-10-23T10:00:00+00:00")
check("zabelezeno kao promena", r["changed"], 1)
h = call("GET", "/api/history/polovniautomobili.com:500")
check("poslednji snimak je na upit", h["snapshots"][-1]["on_request"], 1)
check("cena je sad stvarno prazna", h["snapshots"][-1]["price"], None)

print("\n4. Kartica ne sme da pregazi marku/model iz detaljne stranice")
send([{"external_id": "501", "brand": "Honda", "model": "CR-V", "price": 30000,
       "currency": "EUR", "via": "framework-state"}], "2026-10-21T10:00:00+00:00", "detail")
send([{"external_id": "501", "brand": "Honda", "model": "Cr V", "via": "search-card"}],
     "2026-10-21T10:05:00+00:00")
h = call("GET", "/api/history/polovniautomobili.com:501")
check("model ostao autoritativan", h["listing"]["model"], "CR-V")

print("\n5. Kartica sme da popuni ono sto je prazno")
send([{"external_id": "502", "title": "Opel Astra", "price": 8000, "currency": "EUR",
       "via": "search-card"}], "2026-10-21T10:00:00+00:00")
send([{"external_id": "502", "brand": "Opel", "model": "Astra", "via": "search-card"}],
     "2026-10-21T10:05:00+00:00")
h = call("GET", "/api/history/polovniautomobili.com:502")
check("marka popunjena iz kartice", h["listing"]["brand"], "Opel")

print("\n6. Detaljna stranica sme da ispravi ono sto je kartica pogodila")
send([{"external_id": "503", "brand": "Honda", "model": "Cr V", "price": 30000,
       "currency": "EUR", "via": "search-card"}], "2026-10-21T10:00:00+00:00")
send([{"external_id": "503", "brand": "Honda", "model": "CR-V", "via": "framework-state"}],
     "2026-10-21T10:05:00+00:00", "detail")
h = call("GET", "/api/history/polovniautomobili.com:503")
check("model ispravljen", h["listing"]["model"], "CR-V")

print("\n" + ("SVE PROLAZI" if ok else "IMA PADOVA"))
sys.exit(0 if ok else 1)
