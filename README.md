# Auto Radar

Beleži cene polovnih automobila koje **ti** pregledaš i gradi istoriju cena kroz vreme.

Poenta nije da skupi sve oglase danas — nego da za 6 meseci imaš nešto što niko
drugi nema: **kako su se cene kretale**. Ko je snizio, za koliko, posle koliko
dana. To je podatak koji se ne može naknadno kupiti ni iskopirati.

## Kako radi

```
Chrome ekstenzija  →  lokalni collector  →  SQLite
(čita stranice        (Python stdlib,       (radar.db,
 koje otvoriš)         port 8787)            jedan fajl)
```

Ekstenzija **ne pretražuje sama**: ne otvara tabove, ne šalje zahteve sajtu, ne
zaobilazi nikakvu zaštitu. Samo zapisuje ono što je bilo na ekranu dok si ti
normalno pregledao oglase. Pregledanje je tvoje — ovo je beležnica.

### Kada se skuplja

Ekstenzija se budi samo na stranicama `polovniautomobili.com`:

| Okidač | Kada |
|---|---|
| Učitavanje stranice | 600 ms pošto se DOM smiri |
| Izmena DOM-a | ponovo, odloženo 600 ms (lazy-load, beskonačni scroll) |
| SPA navigacija | promena URL-a bez reload-a, provera svake sekunde |
| Ručno | dugme *Skeniraj stranicu* u popup-u |

Zaštite od divljanja: najviše 40 skeniranja po stranici, i isti oglas sa istom
cenom i kilometražom se ne šalje dvaput u istoj poseti.

### Automatsko skupljanje

**Istorija nastaje samo iz ponovljenih viđenja** — oglas viđen jednom je jedna
tačka, ne istorija. Da to ne zavisi od toga hoćeš li se svakog jutra setiti,
ekstenzija ume i sama da obilazi tvoje pretrage.

Upišeš URL-ove pretraga u popup, uključiš prekidač, i dalje ide samo: jednom u
nekoliko minuta otvori **jednu** stranicu u pozadinskom tabu, pročita je,
zatvori tab. Kad završi prvu stranu pretrage, doda sledeću u red; kad obiđe sve,
vraća se na početak jer su cene možda mrdnule.

| Podrazumevano | Vrednost | Čemu služi |
|---|---|---|
| `enabled` | **isključeno** | nikad ne kreće samo od instalacije |
| `intervalMinutes` | 4 | prosečna pauza; ±40% nasumično da ritam ne bude mašinski |
| `dailyCap` | 150 | tvrdi dnevni limit |
| `revisitHours` | 24 | koliko stranica mora da ostari pre ponovne posete |
| `maxDepth` | 15 | koliko strana pagiracije po pretrazi |

Pokrivenost raste nedeljama, namerno: prvo prva strana svake pretrage, pa dublje,
pa iznova. Radi samo dok je Chrome upaljen, nikad više od jednog taba odjednom, i
poštuje `Disallow` listu iz njihovog `robots.txt` (lista je u `crawler.js`).

> **Šta ovo jeste, a šta nije.** Nije headless browser, nema TLS impersonation ni
> rešavanja izazova — to je tvoj Chrome, pa nema šta da se zaobilazi i nema šta
> da pukne kad sajt promeni zaštitu. Ali automatizovan pristup je najverovatnije
> protiv njihovih uslova korišćenja i bez zaobilaženja zaštite. Pri ovakvom tempu
> je to saobraćaj koji se ne razlikuje od običnog korisnika; rizik je mali, nije
> nula. Zato je podrazumevano isključeno i zato limiti stoje gde stoje.

## Pokretanje

**1. Collector**

```bash
python3 server/server.py
```

Bez ijedne zavisnosti — ni pip, ni venv, ni Node. Pri prvom pokretanju napravi
`server/token.txt` i `server/radar.db`.

**2. Ekstenzija**

1. Chrome → `chrome://extensions`
2. Uključi **Developer mode** (gore desno)
3. **Load unpacked** → izaberi folder `extension/`
4. Klikni ikonicu Auto Radar → nalepi token iz `server/token.txt`

**3. Dashboard**

Otvori <http://127.0.0.1:8787> dok collector radi. Token se ubacuje sam — stranica
se servira sa istog loopback porta, pa ga ne moraš lepiti dvaput.

Tri prikaza: cena prema kilometraži (tačke ispod trend linije su jeftinije nego
što im kilometraža nalaže), istorija cene za pojedinačni oglas, i tabela
sniženih. Grafikoni su inline SVG — bez ijedne JS biblioteke.

**4. Pregledaj aute**

Otvori pretragu na polovniautomobili.com. Brojači u popup-u treba da skoče.
Ako ne skoče, vidi *Kad parser ne uhvati* niže.

> Collector ne mora da radi non-stop. Dok je ugašen, ekstenzija čuva sve u red
> čekanja i pošalje kad se vrati.

### Dev i produkcija

`--db` i `--port` razdvajaju okruženja. Prava istorija cena je nezamenljiva —
jednom posejani lažni podaci se ne mogu čisto razdvojiti od pravih, pa se svako
isprobavanje radi nad zasebnom bazom:

```bash
python3 server/server.py                                    # prod: radar.db na 8787
python3 server/server.py --port 8788 --db server/demo.db    # dev: demo.db na 8788
```

Sve `server/*.db` je u `.gitignore`. Ekstenzija gađa onaj port koji joj upišeš u
popup-u, pa prebacivanje na dev znači samo izmenu porta tamo.

## Šta se čuva

| Tabela | Šta |
|---|---|
| `listings` | Oglas: model, godište, gorivo, menjač, prvi/poslednji put viđen |
| `snapshots` | Cena i kilometraža — **samo kad se promene**, ne pri svakom viđenju |
| `ingest_log` | Poslednjih 500 skeniranja, za debug parsera |

`snapshots` namerno čuva samo promene. Zato baza ostaje sitna godinama, a svaki
red je stvarni događaj: *"ovog dana je cena pala sa X na Y"*.

## API

Sve osim `/health` traži header `X-Radar-Token`.

```bash
TOKEN=$(cat server/token.txt)

curl -s -H "X-Radar-Token: $TOKEN" localhost:8787/api/summary
curl -s -H "X-Radar-Token: $TOKEN" localhost:8787/api/drops          # pali cene
curl -s -H "X-Radar-Token: $TOKEN" "localhost:8787/api/listings?brand=volkswagen"
curl -s -H "X-Radar-Token: $TOKEN" localhost:8787/api/history/polovniautomobili.com:12345
```

## Kad parser ne uhvati

Izvlačenje ide u četiri nivoa, od najpreciznijeg ka najtolerantnijem:

1. `__NEXT_DATA__` / `__NUXT__` — stanje frameworka, ako ga sajt izlaže
2. JSON-LD — strukturni podaci za Google, obično stabilni
3. Labelirani redovi — "Godište", "Kilometraža", "Gorivo"
4. Regex nad tekstom kartice — uvek nešto uhvati

Svaki zapis nosi polje `via` sa nivoom koji je stvarno odradio posao. Namerno
nema ručno biranih CSS klasa — one se menjaju na svakih par meseci i parser
tiho crkne.

**Ako brojači stoje na nuli:** na stranici oglasa klikni *Kopiraj debug* u
popup-u. Dobiješ JSON sa brojem pronađenih linkova, koji nivo je radio, i
koliko je polja popunjeno po oglasu. To je dovoljno da se parser našteluje.

```sql
-- koji nivo nosi teret
SELECT via, COUNT(*) FROM snapshots GROUP BY via ORDER BY 2 DESC;
```

## Status

Faza 1 — skupljanje i prikaz. Radi i testirano:

```bash
python3 server/server.py --port 8799 --db server/test.db   # pa u drugom terminalu:
node extension/test/crawler.test.mjs                       # logika obilaska: 30/30
```

- ingest, detekcija promena, dopuna iz detaljne stranice, padovi cena: 16/16
- parseri cena/km/godišta (sr-RS format): 23/23
- crawler: robots lista, dedupe, dnevni limit, dubina, ponovna poseta,
  odblokiranje zaglavljenog taba: 30/30
- dashboard proveren uživo na 44 oglasa kroz 7 nedelja, u light i dark temi

Nije još urađeno:

- **DOM selektori nisu provereni na živoj stranici** — brojevi i labele jesu,
  ali raspored kartica nije, jer sajt blokira pristup van pravog browsera.
  Zato postoji *Kopiraj debug*.
- Deal score kao broj (trend linija postoji, ocena po oglasu ne)
- Telegram alerti
- Detekcija nestalih oglasa (`gone_since` kolona postoji, sweep ne)
- Normalizacija modela — `brand`/`model` se popune tek kad otvoriš detalje
  oglasa; dok su prazni, oglasi se u izborniku grupišu zajedno

## Pravna napomena

`robots.txt` polovniautomobili.com ne zabranjuje stranice oglasa (zabranjuje
`/api/`, login i plaćanje). Ovaj alat ih i ne dira sam — čita samo ono što je
tvoj browser ionako učitao, tvojim tempom, po tvojoj nameri.

Ako ovo ikad preraste u proizvod koji se prodaje, pristup podacima treba rešiti
kako treba: dogovor sa sajtom, plaćeni data provider, ili tržište sa zvaničnim
API-jem. Gradi vrednost na **svojoj agregaciji kroz vreme**, ne na preprodaji
tuđeg sadržaja.
