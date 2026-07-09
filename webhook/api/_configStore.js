// Armazenamento simples da configuração do agente (compartilhado entre as funções).
// Usa /tmp (persiste enquanto a instância está "quente"); em cold start volta ao env.
const fs = require('fs');
const PATH = '/tmp/versatil-agent-config.json';

function readConfig() {
  try { return JSON.parse(fs.readFileSync(PATH, 'utf8')); } catch (e) { return null; }
}
function writeConfig(cfg) {
  try { fs.writeFileSync(PATH, JSON.stringify(cfg)); return true; } catch (e) { return false; }
}
module.exports = { readConfig, writeConfig };
