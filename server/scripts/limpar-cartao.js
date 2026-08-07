/**
 * Apaga as despesas de um cartão, mantendo o cadastro dele.
 *
 *   npm run limpar -- "Itau"                 (mostra o que seria apagado)
 *   npm run limpar -- "Itau" --sim           (apaga tudo do cartão)
 *   npm run limpar -- "Itau" --sim --mes 2026-08
 *   npm run limpar -- "Itau" --sim --so-avulsos
 *
 * Guarda em `data/` o que sai, antes de mexer. Contas, receitas, categorias, pessoas e os
 * outros cartões não são tocados. O recorte é o mesmo da tela de cartões — os
 * dois caminhos chamam o serviço de limpeza.
 */
import { db, migrar, esperarBanco, encerrar } from '../db/index.js';
import { ehMes } from '../lib/mes.js';
import { levantarLimpeza, resumirLimpeza, executarLimpeza } from '../services/limpezaCartao.js';

const args = process.argv.slice(2);
const busca = args.find((a) => !a.startsWith('--'));
const confirmado = args.includes('--sim');
const soAvulsos = args.includes('--so-avulsos');
const mes = args.includes('--mes') ? args[args.indexOf('--mes') + 1] : null;

async function principal() {
  if (!busca) {
    console.log('\nInforme o cartão:  npm run limpar -- "Itau"\n');
    return 1;
  }
  if (mes && !ehMes(mes)) {
    console.log(`\nMês inválido: ${mes}. Use AAAA-MM.\n`);
    return 1;
  }

  await esperarBanco();
  await migrar();

  // ILIKE no lugar do LIKE: no SQLite a comparação de texto já era insensível
  // a maiúsculas, no Postgres não é — sem isto, procurar por "itau" deixaria
  // de achar "Itau Uniclass" e o comando diria que o cartão não existe.
  const cartao = await db.prepare('SELECT id, nome FROM cartoes WHERE nome ILIKE ?').get(`%${busca}%`);
  if (!cartao) {
    const nomes = (await db.prepare('SELECT nome FROM cartoes').all()).map((c) => c.nome);
    console.log(`\nNenhum cartão com "${busca}". Cadastrados: ${nomes.join(', ') || '(nenhum)'}\n`);
    return 1;
  }

  const alvo = await levantarLimpeza(cartao.id, { mes, soAvulsos });
  const previa = resumirLimpeza(alvo);

  console.log(`\nCartão: ${cartao.nome}`);
  console.log(`Recorte: ${mes || 'todos os meses'}${soAvulsos ? ' · somente gastos avulsos' : ''}`);
  Object.entries(previa.itens).forEach(([tabela, i]) => console.log(`  ${tabela.padEnd(15)} ${i.quantidade}`));
  console.log(`  ${'TOTAL'.padEnd(15)} ${previa.quantidade}`);

  if (previa.quantidade === 0) {
    console.log('\nNada a apagar.\n');
    return 0;
  }

  if (!confirmado) {
    console.log('\nNada foi apagado. Para confirmar, repita o comando com --sim\n');
    return 0;
  }

  const { backup, quantidade } = await executarLimpeza(alvo);
  console.log(`\nBackup: ${backup}`);
  console.log(`Removidos ${quantidade} registros de "${cartao.nome}".`);
  console.log('Para trazer tudo de volta:  npm run importar -- "Planilha 2026.xlsx"\n');
  return 0;
}

principal()
  .then((codigo) => { process.exitCode = codigo; })
  .catch((erro) => {
    console.error('\nFalhou:', erro.message, '\n');
    process.exitCode = 1;
  })
  .finally(() => encerrar());
