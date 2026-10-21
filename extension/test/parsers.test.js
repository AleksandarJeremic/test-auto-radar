// Exercises the DOM-free half of extract.js against real-world sr-RS formatting.
let fails = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { fails++; print(`  FAIL  ${label}: ${g} (ocekivano ${w})`); }
  else print(`  PASS  ${label}: ${g}`);
}

print("\nCene");
eq('"14.500 €"',            Radar.parsePrice("14.500 €").price, 14500);
eq('"14.500 EUR"',          Radar.parsePrice("14.500 EUR").price, 14500);
eq('"1.450.000 RSD" valuta', Radar.parsePrice("1.450.000 RSD").currency, "RSD");
eq('"8 900 €" (razmak)',    Radar.parsePrice("8 900 €").price, 8900);
eq('nbsp "12\\u00a0300 €"', Radar.parsePrice("12 300 €").price, 12300);
eq('"Po dogovoru"',         Radar.parsePrice("Po dogovoru").on_request, true);
eq('cena u recenici',       Radar.parsePrice("Golf 7, odlicno stanje, 13.950 € fiksno").price, 13950);
eq('bez cene -> null',      Radar.parsePrice("Golf 7 1.6 TDI"), null);
eq('smece "50 €" odbijeno', Radar.parsePrice("50 €"), null);

print("\nKilometraza");
eq('"180.000 km"',   Radar.parseMileage("180.000 km"), 180000);
eq('"180000 km"',    Radar.parseMileage("180000 km"), 180000);
eq('"1.250 km"',     Radar.parseMileage("1.250 km"), 1250);
eq('u kartici',      Radar.parseMileage("2015. | 180.000 km | Dizel"), 180000);
eq('nema km',        Radar.parseMileage("2015. Dizel"), null);

print("\nGodiste");
eq('"2015."',          Radar.parseYear("2015."), 2015);
eq('iz kartice',       Radar.parseYear("Golf 7 | 2016. | 150.000 km"), 2016);
eq('ne hvata 1.6',     Radar.parseYear("1.6 TDI"), null);
eq('ne hvata 180.000', Radar.parseYear("180.000 km"), null);
eq('granica 1899',     Radar.parseYear("1899"), null);

print("\nBrojevi");
eq('"1.598"',  Radar.toNumber("1.598"), 1598);
eq('"81 kW"',  Radar.toNumber("81 kW"), 81);
eq('"12,5"',   Radar.toNumber("12,5"), 12.5);
eq('prazno',   Radar.toNumber(""), null);

print("\n" + (fails ? `IMA ${fails} PADOVA` : "SVE PROLAZI"));

// jsc does not expose a process exit code, so signal failure by throwing.
if (fails) throw new Error(`${fails} padova`);
