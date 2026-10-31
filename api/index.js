// Entrada serverless (Vercel). Toda rota /api/*, /webhooks/* e /admin* é
// reescrita pra cá (ver vercel.json); os arquivos de public/ a Vercel serve direto.
module.exports = require("../server/index.js");
