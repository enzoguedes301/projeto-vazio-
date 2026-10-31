// Cidade do lead: detectada pelo IP, resolvida pelo slug da URL ou buscada por texto.
// Qualquer cidade do Brasil funciona — ela é registrada no banco na primeira vez,
// com uma rua real perto do centro (endereço do "restaurante" daquela cidade) e as
// coordenadas desse ponto, usadas como referência do frete.
const fs = require("node:fs");
const path = require("node:path");
const { cidadesDb } = require("./db");

const DADOS = path.join(__dirname, "..", "public", "dados");
const cfgCidades = () => JSON.parse(fs.readFileSync(path.join(DADOS, "cidades.json"), "utf8"));
const modelo = () => JSON.parse(fs.readFileSync(path.join(DADOS, "perfil_modelo.json"), "utf8"));

const UF_NOME = {
  AC: "Acre", AL: "Alagoas", AP: "Amapá", AM: "Amazonas", BA: "Bahia", CE: "Ceará", DF: "Distrito Federal",
  ES: "Espírito Santo", GO: "Goiás", MA: "Maranhão", MT: "Mato Grosso", MS: "Mato Grosso do Sul", MG: "Minas Gerais",
  PA: "Pará", PB: "Paraíba", PR: "Paraná", PE: "Pernambuco", PI: "Piauí", RJ: "Rio de Janeiro", RN: "Rio Grande do Norte",
  RS: "Rio Grande do Sul", RO: "Rondônia", RR: "Roraima", SC: "Santa Catarina", SP: "São Paulo", SE: "Sergipe", TO: "Tocantins",
};
const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const log = (...a) => console.log(new Date().toLocaleTimeString("pt-BR"), ...a);
const UF_POR_NOME = Object.fromEntries(Object.entries(UF_NOME).map(([uf, n]) => [norm(n), uf]));
const slugify = (nome, uf) => `${norm(nome).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${uf.toLowerCase()}`;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, headers = {}, timeoutMs = 4000) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

// ------------------------------------------------------------ Nominatim
function cidadeDoResultado(r) {
  const a = r.address || {};
  const nome = a.city || a.town || a.village || a.municipality || r.name;
  const iso = a["ISO3166-2-lvl4"] || "";
  const uf = iso.startsWith("BR-") ? iso.slice(3) : UF_POR_NOME[norm(a.state)];
  if (!nome || !uf || a.country_code !== "br") return null;
  return { nome, uf, lat: parseFloat(r.lat), lon: parseFloat(r.lon) };
}
async function nominatim(params, ua) {
  const qs = new URLSearchParams({ format: "json", limit: "1", addressdetails: "1", countrycodes: "br", ...params });
  try {
    const j = await getJson(`https://nominatim.openstreetmap.org/search?${qs}`, { "User-Agent": ua }, 6000);
    return j && j[0] ? cidadeDoResultado(j[0]) : null;
  } catch {
    return null;
  }
}
const centroDaCidade = (nome, uf, ua) => nominatim({ city: nome, state: UF_NOME[uf] || uf, country: "Brasil" }, ua);
const buscarCidade = (texto, ua) => nominatim({ q: `${texto}, Brasil` }, ua);

// coordenadas de um endereço (rua + número)
async function geocodeEndereco({ rua, numero, bairro, cep }, nome, uf, ua) {
  const base = { city: nome, state: UF_NOME[uf] || uf, country: "Brasil", format: "json", limit: "1", countrycodes: "br" };
  const tentativas = [
    { ...base, street: `${numero} ${rua}` },
    { ...base, street: rua },
    cep ? { postalcode: String(cep).replace(/\D/g, ""), country: "Brasil", format: "json", limit: "1" } : null,
    bairro ? { ...base, q: `${bairro}, ${nome}, ${UF_NOME[uf] || uf}, Brasil` } : null,
  ].filter(Boolean);
  for (const t of tentativas) {
    try {
      const j = await getJson(`https://nominatim.openstreetmap.org/search?${new URLSearchParams(t)}`, { "User-Agent": ua }, 6000);
      if (j && j[0]) return { lat: parseFloat(j[0].lat), lon: parseFloat(j[0].lon) };
    } catch { /* próxima tentativa */ }
    await espera(1100); // limite do Nominatim: 1 req/s
  }
  return null;
}

// ------------------------------------------------- rua real da cidade
// Plano A: sorteia um ponto a até 1,5 km do centro e pergunta ao Nominatim qual rua
// fica ali (reverse geocoding). Garante restaurante central e já devolve as coordenadas.
async function ruaPertoDoCentro(lat, lon, ua) {
  for (let i = 0; i < 3; i++) {
    const dist = 300 + Math.random() * 1200, ang = Math.random() * 2 * Math.PI;
    const dLat = (dist * Math.cos(ang)) / 111_320, dLon = (dist * Math.sin(ang)) / (111_320 * Math.cos((lat * Math.PI) / 180));
    const qs = new URLSearchParams({ format: "json", zoom: "17", addressdetails: "1", lat: String(lat + dLat), lon: String(lon + dLon) });
    try {
      const j = await getJson(`https://nominatim.openstreetmap.org/reverse?${qs}`, { "User-Agent": ua }, 6000);
      const a = (j && j.address) || {};
      const rua = a.road || a.pedestrian || a.residential;
      if (rua && !/^(rua|avenida|travessa) [a-z0-9]$/i.test(rua)) {
        return {
          rua, numero: a.house_number || String(50 + Math.floor(Math.random() * 900)),
          bairro: a.suburb || a.neighbourhood || a.city_district || a.quarter || "Centro",
          cep: a.postcode || null, lat: parseFloat(j.lat), lon: parseFloat(j.lon),
        };
      }
    } catch { /* tenta outro ponto */ }
    await espera(1100);
  }
  return null;
}

// Plano B (sem mapa): logradouros do ViaCEP por termos comuns, preferindo o Centro.
const TERMOS_RUA = ["Rua Sao", "Rua Santo", "Rua Jose", "Rua Maria", "Rua Joao", "Avenida Brasil", "Rua Sete", "Rua"];
async function ruaAleatoria(nome, uf) {
  const cidadeUrl = encodeURIComponent(norm(nome));
  let achados = [];
  for (const termo of TERMOS_RUA) {
    try {
      const l = await getJson(`https://viacep.com.br/ws/${uf}/${cidadeUrl}/${encodeURIComponent(termo)}/json/`, {}, 6000);
      if (Array.isArray(l)) achados = achados.concat(l.filter((r) => r.logradouro && r.logradouro.length >= 9 && !/\d/.test(r.logradouro)));
    } catch { /* tenta o próximo termo */ }
    if (achados.length >= 8) break;
  }
  if (!achados.length) return null;
  const centro = achados.filter((r) => norm(r.bairro) === "centro");
  const lista = centro.length ? centro : achados;
  const r = lista[Math.floor(Math.random() * lista.length)];
  return { rua: r.logradouro, bairro: r.bairro || "Centro", cep: r.cep, numero: String(50 + Math.floor(Math.random() * 900)) };
}

// ------------------------------------------------------------- registro
async function registrar({ nome, uf, lat, lon }, ua) {
  const slug = slugify(nome, uf);
  const existente = await cidadesDb.porSlug(slug);
  if (existente) return existente;
  if (lat == null || lon == null) {
    const c = await centroDaCidade(nome, uf, ua);
    if (c) { nome = c.nome; lat = c.lat; lon = c.lon; }
  }
  let end = null;
  if (lat != null && lon != null) {
    await espera(1100);
    end = await ruaPertoDoCentro(lat, lon, ua);
  }
  if (!end) {
    const viaCep = await ruaAleatoria(nome, uf);
    if (viaCep) {
      await espera(1100);
      const ponto = await geocodeEndereco(viaCep, nome, uf, ua);
      end = { ...viaCep, lat: ponto ? ponto.lat : null, lon: ponto ? ponto.lon : null };
    }
  }
  if (!end) end = { rua: "Rua das Cerejeiras", numero: "120", bairro: "Centro", cep: null, lat: null, lon: null };
  return cidadesDb.salvar({
    slug, nome, uf,
    rua: end.rua, numero: end.numero, bairro: end.bairro, cep: end.cep,
    lat: end.lat ?? lat ?? null,
    lon: end.lon ?? lon ?? null,
  });
}

// ------------------------------------------------------- detecção por IP
const cacheIp = new Map(); // ip -> { cidade, em }
const ipPrivado = (ip) => !ip || /^(::1|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::ffff:(127|10|192\.168)\.|fc|fe80)/.test(ip);

async function detectarPorIp(ip, ua) {
  const chave = ipPrivado(ip) ? "self" : ip;
  const c = cacheIp.get(chave);
  if (c && Date.now() - c.em < 3600_000) return c.cidade;
  let cidade = null;
  try {
    const url = chave === "self" ? "https://get.geojs.io/v1/ip/geo.json" : `https://get.geojs.io/v1/ip/geo/${chave}.json`;
    const g = await getJson(url);
    const uf = UF_POR_NOME[norm(g.region)];
    if (g.country_code === "BR" && g.city && uf) {
      cidade = await registrar({ nome: g.city, uf, lat: null, lon: null }, ua);
      if (cidade.lat == null && g.latitude) cidade = await cidadesDb.salvar({ ...cidade, lat: +g.latitude, lon: +g.longitude });
      log(`cidade detectada por IP: ${cidade.nome} - ${cidade.uf} → ${cidade.rua}, ${cidade.numero}`);
    }
  } catch { /* sem rede: padrão */ }
  cacheIp.set(chave, { cidade, em: Date.now() });
  return cidade;
}

// ------------------------------------------------------- slug da URL
async function resolverSlug(slug, ua) {
  if (!slug) return null;
  const existente = await cidadesDb.porSlug(slug);
  if (existente) return existente;
  const m = String(slug).match(/^(.+)-([a-z]{2})$/i);
  if (!m || !UF_NOME[m[2].toUpperCase()]) return null;
  const uf = m[2].toUpperCase();
  const c = await buscarCidade(`${m[1].replace(/-/g, " ")}, ${UF_NOME[uf]}`, ua);
  return c && c.uf === uf ? registrar(c, ua) : null;
}

async function padrao(ua) {
  const p = cfgCidades().padrao;
  return registrar({ nome: p.nome, uf: p.uf, lat: null, lon: null }, ua);
}

function ipDaRequisicao(req) {
  const xf = req.headers["x-forwarded-for"];
  return (xf ? String(xf).split(",")[0].trim() : req.socket && req.socket.remoteAddress) || "";
}

// perfil completo que o app consome, com a cidade preenchida
function perfil(cidade) {
  const m = modelo();
  return {
    ...m,
    id: cidade.id,
    url_name: cidade.slug,
    city: cidade.nome,
    state: cidade.uf,
    street: cidade.rua || m.street,
    address_number: cidade.numero || m.address_number,
    neighborhood: cidade.bairro || m.neighborhood,
    latitude: cidade.lat != null ? String(cidade.lat) : "",
    longitude: cidade.lon != null ? String(cidade.lon) : "",
  };
}

module.exports = { cfgCidades, modelo, registrar, detectarPorIp, resolverSlug, buscarCidade, padrao, ipDaRequisicao, perfil, UF_NOME };
