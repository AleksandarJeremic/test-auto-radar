let fails = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { fails++; print(`  FAIL  ${label}: ${g} (ocekivano ${w})`); }
  else print(`  PASS  ${label}: ${g}`);
}
const B = "https://www.polovniautomobili.com/auto-oglasi/123/";

print("\nMarka i model iz slug-a");
eq('hyundai-tucson-16-tgdi', Radar.fromSlug(B+"hyundai-tucson-16-tgdi-vision-2"), {brand:"Hyundai", model:"Tucson"});
eq('volkswagen-golf-7 (cifra ostaje)', Radar.fromSlug(B+"volkswagen-golf-7-16-tdi"), {brand:"Volkswagen", model:"Golf 7"});
eq('alfa-romeo (crtica u marki)', Radar.fromSlug(B+"alfa-romeo-giulietta-14"), {brand:"Alfa Romeo", model:"Giulietta"});
eq('mercedes-benz', Radar.fromSlug(B+"mercedes-benz-c-klasa-220"), {brand:"Mercedes Benz", model:"C Klasa"});
eq('land-rover', Radar.fromSlug(B+"land-rover-discovery-sport"), {brand:"Land Rover", model:"Discovery Sport"});
eq('honda-cr-v (inicijali ostaju spojeni)', Radar.fromSlug(B+"honda-cr-v-20-hybrid"), {brand:"Honda", model:"CR-V"});
eq('kubikaza prekida model', Radar.fromSlug(B+"opel-astra-20-dti"), {brand:"Opel", model:"Astra"});
eq('nepoznata marka -> prazno', Radar.fromSlug(B+"nekakav-auto-bezveze"), {});
eq('smece -> prazno', Radar.fromSlug("nije-url"), {});
eq('marka bez modela', Radar.fromSlug(B+"zastava"), {brand:"Zastava", model:null});

print("\nGranice cene");
eq('25.990 € prolazi', Radar.parsePrice("25.990 €").price, 25990);
eq('442.999 € odbijeno (preko granice)', Radar.parsePrice("442.999 €"), null);
eq('150 € odbijeno (ispod granice)', Radar.parsePrice("150 €"), null);
eq('3.500.000 RSD prolazi', Radar.parsePrice("3.500.000 RSD").price, 3500000);
eq('99.000.000 RSD odbijeno', Radar.parsePrice("99.000.000 RSD"), null);

print("\nSlepljeni brojevi (pravi slucajevi sa zivog sajta)");
eq('"Advance 4 42.999 EUR" -> 42999', Radar.parsePrice("Honda CR-V 2.0 Advance 4 42.999 EUR").price, 42999);
eq('"3 47.000 km" -> 47000', Radar.parseMileage("Hybrid Advance 3 47.000 km"), 47000);
eq('"2024 347.000 km" -> 347000', Radar.parseMileage("2024 347.000 km"), 347000);
eq('grupe od 3 cifre obavezne', Radar.parsePrice("12 34.999 EUR").price, 34999);
eq('obican broj bez grupa', Radar.parseMileage("180000 km"), 180000);

print("\nGorivo i menjac iz teksta kartice");
eq('dizel', Radar.fromCardWords("2015. 180.000 km Dizel Manuelni").fuel, "Dizel");
eq('menjac', Radar.fromCardWords("2015. 180.000 km Dizel Manuelni").transmission, "Manuelni");
eq('automatik', Radar.fromCardWords("Automatski menjac").transmission, "Automatski");
eq('benzin + gas pre benzina', Radar.fromCardWords("Benzin + gas").fuel, "Benzin + gas");
eq('hibrid', Radar.fromCardWords("2.0 Hybrid Advance hibridni").fuel, "Hibridni pogon");
eq('nema goriva u tekstu', Radar.fromCardWords("Honda CR-V 2026").fuel, undefined);
eq('ne pali na "Benzinska pumpa"', Radar.fromCardWords("Auto placa Benzinska pumpa doo").fuel, undefined);

print("\n" + (fails ? `IMA ${fails} PADOVA` : "SVE PROLAZI"));

// jsc does not expose a process exit code, so signal failure by throwing.
if (fails) throw new Error(`${fails} padova`);
