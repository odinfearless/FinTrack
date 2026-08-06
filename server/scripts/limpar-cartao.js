/**
 * Apaga as despesas de um cartão, mantendo o cadastro dele.
 *
 *   npm run limpar -- "Itau"                 (mostra o que seria apagado)
 *   npm run limpar -- "Itau" --sim           (apaga tudo do cartão)
 *   npm run limpar -- "Itau" --sim --mes 2026-08
 *   npm run limpar -- "Itau" --sim --so-avulsos
 *
 * Faz cópia do banco antes de mexer. Contas, receitas, categorias, pessoas e os
 * outros cartões não são tocados. O recorte é o mesmo da tela de cartões — os
 * dois caminhos chamam o serviço de limpeza.
 */
import { db, migrar } from '../db/index.js';
import { ehMes } from '../lib/mes.js';
import { levantarLimpeza, resumirLimpeza, executarLimpeza } from '../services/limpezaCartao.js';

const args = process.argv.slice(2);
const busca = args.find((a) => !a.startsWith('--'));
const confirmado = args.includes('--sim');
const soAvulsos = args.includes('--so-avulsos');
const mes = args.includes('--mes') ? args[args.indexOf('--mes') + 1] : null;

if (!busca) {
  console.log('\nInforme o cartão:  npm run limpar -- "Itau"\n');
  process.exit(1);
}
if (mes && !ehMes(mes)) {
  console.log(`\nMês inválido: ${mes}. Use AAAA-MM.\n`);
  process.exit(1);
}

migrar();

const cartao = db.prepare('SELECT id, nome FROM cartoes WHERE nome LIKE ?').get(`%${busca}%`);
if (!cartao) {
  const nomes = db.prepare('SELECT nome FROM cartoes').all().map((c) => c.nome);
  console.log(`\nNenhum cartão com "${busca}". Cadastrados: ${nomes.join(', ') || '(nenhum)'}\n`);
  process.exit(1);
}

const alvo = levantarLimpeza(cartao.id, { mes, soAvulsos });
const previa = resumirLimpeza(alvo);

console.log(`\nCartão: ${cartao.nome}`);
console.log(`Recorte: ${mes || 'todos os meses'}${soAvulsos ? ' · somente gastos avulsos' : ''}`);
Object.entries(previa.itens).forEach(([tabela, i]) => console.log(`  ${tabela.padEnd(15)} ${i.quantidade}`));
console.log(`  ${'TOTAL'.padEnd(15)} ${previa.quantidade}`);

if (previa.quantidade === 0) {
  console.log('\nNada a apagar.\n');
  process.exit(0);
}

if (!confirmado) {
  console.log('\nNada foi apagado. Para confirmar, repita o comando com --sim\n');
  process.exit(0);
}

const { backup, quantidade } = executarLimpeza(alvo);
console.log(`\nBackup: ${backup}`);
console.log(`Removidos ${quantidade} registros de "${cartao.nome}".`);
console.log('Para trazer tudo de volta:  npm run importar -- "Planilha 2026.xlsx"\n');
