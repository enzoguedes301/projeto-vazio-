// Cálculo de taxa e tempo de entrega pela distância entre o endereço/CEP do
// cliente e a cidade identificada (coordenadas do profile.json da cidade).
//
// Geocodificação: ViaCEP (CEP -> cidade/UF, valida se é a cidade certa) e
// Nominatim/OpenStreetMap (endereço -> lat/lon). Resultados ficam em cache
// no SQLite pra respeitar o limite de 1 req/s do Nominatim.
const { geocache } = require("./db");

const norm = (s) =>
  String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function getJson(url, headers = {}, timeoutMs = 7000) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

async function viaCep(cep) {
  const limpo = String(cep || "").replace(/\D/g, "");
  if (limpo.length !== 8) return null;
  try {
    const j = await getJson(`https://viacep.com.br/ws/${limpo}/json/`);
    return j && !j.erro ? j : null;
  } catch {
    return null;
  }
}

async function nominatim(params, userAgent) {
  const qs = new URLSearchParams({ format: "json", limit: "1", countrycodes: "br", ...params });
  try {
    const j = await getJson(`https://nominatim.openstreetmap.org/search?${qs}`, { "User-Agent": userAgent });
    return j && j[0] ? { lat: parseFloat(j[0].lat), lon: parseFloat(j[0].lon) } : null;
  } catch {
    return null;
  }
}

// Tenta do mais preciso pro mais genérico:
//   rua+número+bairro+cidade (texto livre, desambigua ruas repetidas) -> rua+número -> rua -> CEP -> bairro
async function geocodificar(end, cidade, cfg) {
  const chave = norm([end.zip_code, end.street, end.house_number, end.neighborhood, end.city].join("|"));
  const cache = await geocache.ler(chave);
  if (cache) return cache.lat != null ? { lat: cache.lat, lon: cache.lon } : null;

  const ua = cfg.geocoder.user_agent;
  const city = end.city || cidade.nome, state = end.state || cidade.uf;
  const tentativas = [];
  if (end.street && end.neighborhood)
    tentativas.push({ q: [end.street, end.house_number, end.neighborhood, city, state, "Brasil"].filter(Boolean).join(", ") });
  if (end.street && end.house_number) tentativas.push({ street: `${end.house_number} ${end.street}`, city, state });
  if (end.street) tentativas.push({ street: end.street, city, state });
  if (end.zip_code) tentativas.push({ postalcode: String(end.zip_code).replace(/\D/g, ""), country: "Brasil" });
  if (end.neighborhood) tentativas.push({ q: `${end.neighborhood}, ${city}, ${state}, Brasil` });

  let achado = null;
  for (const t of tentativas) {
    achado = await nominatim(t, ua);
    if (achado) break;
    await new Promise((r) => setTimeout(r, 1100)); // limite do Nominatim
  }
  await geocache.gravar(chave, achado ? achado.lat : null, achado ? achado.lon : null, city);
  return achado;
}

function taxaPorDistancia(km, e) {
  for (const f of e.faixas) if (km <= f.ate_km) return f.taxa;
  const ultima = e.faixas[e.faixas.length - 1];
  return +(ultima.taxa + (km - ultima.ate_km) * e.taxa_km_extra).toFixed(2);
}

const arred5 = (min) => Math.max(5, Math.round(min / 5) * 5);

/**
 * @param end    calculate_tax enviado pelo app: {latitude, longitude, street, house_number, neighborhood, city, state, zip_code}
 * @param cidade entrada de dados/cidades.json + {lat, lon} do profile
 * @returns resposta no formato que o app espera
 */
async function calcular(end, cidade, cfg) {
  const e = cfg.entrega;

  // 1. CEP de outra cidade -> fora da área
  if (end.zip_code) {
    const v = await viaCep(end.zip_code);
    if (v && norm(v.localidade) !== norm(cidade.nome)) {
      return { status: "out_of_range", value: null, estimated_time: null, distance: null, observation: null };
    }
    if (v) {
      end.street = end.street || v.logradouro;
      end.neighborhood = end.neighborhood || v.bairro;
      end.city = end.city || v.localidade;
      end.state = end.state || v.uf;
    }
  } else if (end.city && norm(end.city) !== norm(cidade.nome)) {
    return { status: "out_of_range", value: null, estimated_time: null, distance: null, observation: null };
  }

  // 2. coordenadas do destino
  let dest = end.latitude && end.longitude ? { lat: +end.latitude, lon: +end.longitude } : null;
  if (!dest) dest = await geocodificar(end, cidade, cfg);

  // 3. distância e taxa
  let km, taxa, observation = null;
  if (dest && cidade.lat && cidade.lon) {
    km = haversineKm(cidade.lat, cidade.lon, dest.lat, dest.lon);
    if (km > e.raio_max_km) {
      return { status: "out_of_range", value: null, estimated_time: null, distance: +km.toFixed(2), observation: null };
    }
    taxa = taxaPorDistancia(km, e);
  } else {
    km = e.distancia_padrao_sem_geo_km;
    taxa = e.taxa_padrao_sem_geo;
    observation = "Taxa estimada — endereço não localizado no mapa";
  }

  return {
    status: "ok",
    value: taxa,
    estimated_time: arred5(e.tempo_base_min + e.min_por_km * km), // o app soma o preparation_time
    distance: +km.toFixed(2),
    delivery_man_fee: null,
    delivery_fee_ref: null,
    observation,
    debug_info: dest ? { destination: { latitude: dest.lat, longitude: dest.lon } } : undefined,
  };
}

module.exports = { calcular, haversineKm };
