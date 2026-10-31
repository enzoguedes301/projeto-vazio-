# Cardápio digital multi-cidade com pedidos

Cardápio online de delivery que se adapta à cidade de quem abre: detecta a localização do
visitante, apresenta o restaurante naquela cidade (endereço real sorteado perto do centro),
calcula o frete pela distância até o endereço do cliente, recebe pedidos com Pix automático
e mostra o acompanhamento em tempo real. Inclui painel de pedidos.

Stack: front React (bundle pronto em `assets/`) + servidor Node **sem dependências**
(`fetch` e SQLite embutidos — Node ≥ 22.13).

## Rodar

```
cp .env.example .env       # preencha as chaves
npm start                  # http://localhost:8090   (painel: /admin)
PORT=3000 npm start
```

Variáveis (`.env` ou da hospedagem):

| Variável | Para quê |
|---|---|
| `TRONFY_API_KEY` | chave **secreta** do Pix (Tronfy) |
| `META_PIXEL_TOKEN` | token da API de Conversões da Meta (opcional) |
| `ADMIN_TOKEN` | senha do painel `/admin` (sobrepõe `server/config.json`) |

## Estrutura

```
index.html                 app + carregador de cidade (chama GET /api/cidade antes de iniciar)
cidades.js                 botão flutuante: mostra a cidade detectada, deixa digitar outra
assets/  img/  fonts/      bundle, fotos dos produtos, fonte
dados/
  cidades.json             cidade padrão e se detecta por IP
  perfil_modelo.json       perfil do restaurante; o servidor preenche cidade/UF/rua/coordenadas
  cardapios/padrao/        categorias/produtos (compartilhado por todas as cidades)
server/
  index.js                 servidor: estáticos + API + painel
  cidades.js               detecta/resolve a cidade do visitante, sorteia a rua, geocodifica
  entrega.js               endereço do cliente -> distância até o restaurante -> taxa e tempo
  pedidos.js               linha do tempo automática e formato do pedido
  pix.js                   cobrança Pix (Tronfy) e QR Code
  meta.js                  Meta Conversions API
  db.js                    SQLite (cidades, clientes, pedidos, cache de geocodificação)
  config.json              porta, token do painel, linha do tempo, regras de frete, pixel
  admin.html               painel de pedidos
  dados.sqlite             banco (criado no primeiro start — FAÇA BACKUP em produção)
scripts/preparar_cidades.js  pré-registra uma lista de cidades
```

## Como funciona

### 1. Cidade do visitante
`index.html` chama `GET /api/cidade` antes de carregar o app. O servidor decide, nesta ordem:

1. **URL** — `/belem-pa`, `/sao-paulo-sp/sacola` (slug = cidade-uf; link compartilhável)
2. **Escolha salva** — se a pessoa digitou outra cidade no botão flutuante
3. **IP** — `get.geojs.io` com o IP do visitante (em localhost usa o IP público da máquina)
4. **Padrão** — `dados/cidades.json` → São Paulo - SP

Qualquer cidade do Brasil funciona. Na primeira vez que uma cidade aparece, o servidor acha o centro
(Nominatim/OpenStreetMap), sorteia um ponto a até 1,5 km e descobre a **rua real** que fica ali
(reverse geocoding), e grava em `cidades` (slug, nome, UF, rua, número, bairro, CEP, lat/lon).
Se o mapa falhar, cai pra uma rua do ViaCEP (preferindo o Centro) e, em último caso, "Rua das Cerejeiras, 120".

`node scripts/preparar_cidades.js lista.txt` (uma "Cidade - UF" por linha) pré-registra cidades
pra que o primeiro visitante de cada uma não espere a geocodificação.

### 2. Endereço do restaurante
`GET /api/perfil/<slug>.json` devolve `perfil_modelo.json` preenchido com a cidade: no app aparece
**"Rua X, nº / Bairro, Cidade - UF / Apenas delivery"** no cabeçalho e no rodapé. O `id` da cidade
vai no header `Company-ID` em toda chamada — é assim que o servidor sabe de qual cidade é cada pedido.

### 3. Frete e tempo (`POST /api/menu/company/orders/calculate_tax`)
1. **ViaCEP** valida o CEP: outra cidade → "Ainda não entregamos na sua região".
2. **Nominatim** geocodifica o endereço (rua+número+bairro → rua → CEP → bairro; cache no SQLite).
3. Distância em linha reta até o **ponto do restaurante daquela cidade**.
4. Taxa pelas faixas de `config.json → entrega` (até 3 km R$ 6 · 6 km R$ 9 · 10 km R$ 13 · depois +R$ 1,50/km);
   tempo = `tempo_base_min + min_por_km × km` (o app soma os 45 min de preparo do perfil).
5. Acima de `raio_max_km` (15) → fora da área. Endereço não localizado → taxa padrão, sem travar a venda.

> Nominatim é gratuito, limitado a ~1 req/s, e exige `user_agent` identificável (`config.json → geocoder`).
> Pra volume alto, trocar por Google Geocoding é só mexer em `entrega.js`/`cidades.js`.

### 4. Pedido e acompanhamento
Finalizar exige cliente identificado (telefone → nome + senha). Depois de confirmar, o app abre
**Seus pedidos** (`/<cidade>/pedidos`, também no menu inferior), com a linha do tempo. O status
**avança sozinho pelo relógio** (recalculado a cada consulta, nada em segundo plano):

| minuto                 | status      | o cliente vê                        |
|------------------------|-------------|-------------------------------------|
| 0                      | `confirmed` | Pedido em produção                  |
| 30                     | `ready`     | Aguardando retirada pelo motorista  |
| 45                     | `released`  | Entrega em andamento — **fica assim até o painel marcar entregue** |
| quando o painel marcar | `delivered` | Pedido entregue                     |
| entregue + 30          | `closed`    | Pedido concluído (vai pro histórico)|

Previsão mostrada ao cliente: 45 min de preparo + trajeto pelo CEP (~15 + 3 min/km) ≈ **1h10**.
Ajustes em `config.json → linha_do_tempo_min` (`entregue_automatico: true` entrega sozinho no tempo estimado).
A tela do cliente atualiza a cada 30 s.

### 4b. Pagamento Pix (Tronfy)
Forma de pagamento **Pix** = Pix automático via Tronfy. O checkout pede o **CPF** (exigência do provedor).

1. Ao confirmar, o servidor cria a cobrança (`POST /v1/pix-charges`, idempotente por pedido) e grava
   `pix_id`, copia-e-cola e validade (`config.json → pix.expiracao_min`, 30 min).
2. O app mostra QR Code (gerado localmente) + botão copiar + contagem regressiva e consulta o pedido a cada 7,5 s.
   Status do pedido: **"Aguardando pagamento"**.
3. Confirmação por **webhook** (`POST /webhooks/tronfy` — cadastre `https://SEU-DOMINIO/webhooks/tronfy`
   no painel do provedor, categoria Transações) **e** por consulta de segurança (máx. 1×/8 s por pedido).
   Nos dois casos o servidor confirma pela API antes de marcar pago.
4. Pago → a linha do tempo começa **a partir do pagamento**. Não pago no prazo → pedido cancelado.
   Dinheiro/cartão continuam na entrega, sem passar pelo provedor.

### 4c. Meta Pixel + API de Conversões
O Pixel está no `index.html` (página única → vale pra todas as telas e cidades). O app dispara
PageView, ViewContent, Search, AddToCart, InitiateCheckout e Purchase. Com `META_PIXEL_TOKEN`
definido, cada evento também é enviado pelo servidor (`server/meta.js`) com o mesmo `event_id`
(a Meta deduplica), mais IP, user-agent e identificadores do cliente com hash.
ID do pixel em `config.json → meta.pixel_id` e no snippet do `index.html`.

### 5. Painel — `/admin`
Pedidos das últimas 36 h, filtro por cidade, itens, endereço, pagamento (com situação do Pix), linha do tempo;
som ao chegar pedido novo. Ações: **marcar entregue**, **concluir**, **cancelar** (com motivo visível ao cliente).

## Deploy

Precisa de hospedagem que rode **Node** com disco persistente pro SQLite:

- **Railway / Render / Fly.io**: `npm start`, porta via `PORT`, variáveis do `.env` nas configurações,
  e um **volume persistente** montado em `server/` — senão o banco some a cada deploy.
- **VPS** (Ubuntu + Nginx): `pm2 start server/index.js --name cardapio`; Nginx com
  `proxy_pass http://127.0.0.1:8090` e HTTPS via Certbot. Atrás de proxy, o IP vem em `X-Forwarded-For` (já tratado).
- **Vercel / serverless**: não tem disco — exige trocar `server/db.js` por um banco externo (Turso/Neon).

## Editar

- Produtos/preços: `dados/cardapios/padrao/categories.json`
- Nome, horário, pagamentos, WhatsApp, tempo de preparo: `dados/perfil_modelo.json`
- Faixas de frete, raio, minutos por km, linha do tempo, pixel: `server/config.json` (reinicie depois)
- Cidade padrão / desligar detecção por IP: `dados/cidades.json`
- Trocar a rua sorteada de uma cidade: apague a linha dela na tabela `cidades` do SQLite

## Pendências
- WhatsApp do perfil é placeholder; CNPJ do rodapé em branco.
- Recuperação de senha por SMS não existe (responde "indisponível"). Cupons: sempre inválidos.
