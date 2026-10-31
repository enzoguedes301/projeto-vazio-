// Pré-registra cidades no banco (sorteia a rua do "restaurante" e geocodifica),
// pra que o primeiro lead de cada cidade não espere a geocodificação.
//
//   node scripts/preparar_cidades.js cidades.txt
//
// cidades.txt: uma por linha, "Cidade - UF"  (ex.: "Uberlândia - MG"). Linhas com # são ignoradas.
// Respeita o limite do Nominatim (~1 req/s): ~4 s por cidade nova. Pode rodar com o servidor ligado.
const fs = require("node:fs");
const path = require("node:path");
const Cidades = require("../server/cidades");
const { cidadesDb } = require("../server/db");

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "server", "config.json"), "utf8"));
const arquivo = process.argv[2];
if (!arquivo) { console.error("uso: node scripts/preparar_cidades.js cidades.txt"); process.exit(1); }

const linhas = fs.readFileSync(arquivo, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

(async () => {
  let ok = 0, falha = 0;
  for (const linha of linhas) {
    const m = linha.match(/^(.+?)\s*[-\/,]\s*([A-Za-z]{2})$/);
    if (!m || !Cidades.UF_NOME[m[2].toUpperCase()]) { console.log(`?  ${linha}  (formato: Cidade - UF)`); falha++; continue; }
    const nome = m[1], uf = m[2].toUpperCase();
    const existente = cidadesDb.todas().find((c) => c.nome.localeCompare(nome, "pt", { sensitivity: "base" }) === 0 && c.uf === uf);
    if (existente) { console.log(`=  ${existente.nome} - ${uf}: ${existente.rua}, ${existente.numero} (já existia)`); ok++; continue; }
    try {
      const achada = await Cidades.buscarCidade(`${nome}, ${Cidades.UF_NOME[uf]}`, cfg.geocoder.user_agent);
      if (!achada || achada.uf !== uf) { console.log(`x  ${linha}: não encontrada no mapa`); falha++; continue; }
      const c = await Cidades.registrar(achada, cfg.geocoder.user_agent);
      console.log(`+  ${c.nome} - ${c.uf}: ${c.rua}, ${c.numero}, ${c.bairro}  (${c.lat?.toFixed(4)}, ${c.lon?.toFixed(4)})`);
      ok++;
    } catch (e) {
      console.log(`x  ${linha}: ${e.message}`); falha++;
    }
    await new Promise((r) => setTimeout(r, 1100));
  }
  console.log(`\n${ok} ok, ${falha} com problema. Total no banco: ${cidadesDb.todas().length}`);
})();
