/**
 * Leva os dados do banco SQLite antigo para o Postgres.
 *
 *   npm run migrar:sqlite            (prévia: conta o que existe, não grava)
 *   npm run migrar:sqlite -- --sim   (executa)
 *
 * O `better-sqlite3` é dependência de desenvolvimento justamente por causa
 * deste script: ele roda uma vez, na máquina de quem migra, e não precisa
 * existir na imagem que vai para o Docker — o que evita carregar um compilador
 * C++ dentro do container só para um arquivo que nunca mais será lido.
 *
 * Três cuidados guiam a ordem das coisas aqui:
 *
 *   ids preservados     as tabelas se referenciam por id, e renumerar exigiria
 *                       reescrever cada chave estrangeira. Por isso a coluna é
 *                       IDENTITY **BY DEFAULT**: aceita o id que vem escrito.
 *   ordem das chaves    cartão antes de lançamento, senão a referência aponta
 *                       para o que ainda não existe.
 *   sequences no fim    inserir id explícito não move o contador do Postgres.
 *                       Sem o realinhamento, o primeiro cadastro feito pela
 *                       tela tentaria o id 1 e esbarraria num que já existe.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { db, transacao, realinharSequences, migrar, esperarBanco, encerrar, descricaoBanco, pastaDados } from '../db/index.js';

// Na ordem em que precisam entrar: quem é referenciado vem antes de quem
// referencia.
const TABELAS = [
  'cartoes',
  'contas_bancarias',
  'categorias',
  'pessoas',
  'lancamentos',
  'parcelamentos',
  'contas',
  'receitas',
  'encargos',
];

function acharBancoAntigo() {
  const explicito = process.env.SQLITE_DB;
  if (explicito) return explicito;
  for (const nome of ['appgastos.db', 'fintrack.db']) {
    const alvo = path.join(pastaDados, nome);
    if (fs.existsSync(alvo)) return alvo;
  }
  return null;
}

/** Colunas que existem nas duas pontas — o resto é ignorado sem alarde. */
async function colunasComuns(sqlite, tabela) {
  const noSqlite = new Set(sqlite.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => c.name));
  const noPostgres = await db.prepare(
    'SELECT column_name FROM information_schema.columns WHERE table_name = ?').all(tabela);
  return noPostgres.map((c) => c.column_name).filter((c) => noSqlite.has(c));
}

async function migrarTabela(sqlite, tabela) {
  const existe = sqlite.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(tabela).n;
  if (!existe) return { tabela, lidos: 0, gravados: 0, motivo: 'tabela não existe no SQLite' };

  const colunas = await colunasComuns(sqlite, tabela);
  const linhas = sqlite.prepare(`SELECT * FROM ${tabela}`).all();
  if (linhas.length === 0) return { tabela, lidos: 0, gravados: 0 };

  const sql = `INSERT INTO ${tabela} (${colunas.join(', ')})
               VALUES (${colunas.map((c) => `@${c}`).join(', ')})
               ON CONFLICT (id) DO NOTHING`;

  let gravados = 0;
  await transacao(async (tx) => {
    const inserir = tx.prepare(sql);
    for (const linha of linhas) {
      const valores = {};
      for (const coluna of colunas) valores[coluna] = linha[coluna] ?? null;
      const { changes } = await inserir.run(valores);
      gravados += changes;
    }
  });

  return { tabela, lidos: linhas.length, gravados };
}

async function principal() {
  const arquivo = acharBancoAntigo();
  if (!arquivo) {
    console.error(`\nNenhum banco SQLite encontrado em ${pastaDados}.`);
    console.error('Aponte um com:  SQLITE_DB=/caminho/para/appgastos.db npm run migrar:sqlite\n');
    process.exit(1);
  }

  const sqlite = new Database(arquivo, { readonly: true });
  const executar = process.argv.includes('--sim');

  console.log(`\nDe:    ${arquivo}`);
  console.log(`Para:  ${descricaoBanco}\n`);

  if (!executar) {
    console.log('Prévia — nada será gravado.\n');
    for (const tabela of TABELAS) {
      const tem = sqlite.prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(tabela).n;
      const n = tem ? sqlite.prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).get().n : 0;
      console.log(`  ${tabela.padEnd(18)} ${String(n).padStart(6)} registros`);
    }
    console.log('\nPara migrar de verdade:  npm run migrar:sqlite -- --sim\n');
    sqlite.close();
    await encerrar();
    return;
  }

  await esperarBanco();
  await migrar();

  console.log('Migrando…\n');
  for (const tabela of TABELAS) {
    const r = await migrarTabela(sqlite, tabela);
    const sufixo = r.motivo ? ` (${r.motivo})`
      : (r.gravados < r.lidos ? ` (${r.lidos - r.gravados} já existiam e foram mantidos)` : '');
    console.log(`  ${r.tabela.padEnd(18)} ${String(r.gravados).padStart(6)} gravados${sufixo}`);
  }

  await realinharSequences();
  console.log('\nSequences realinhadas — novos cadastros continuam do último id.');

  sqlite.close();
  await encerrar();
  console.log('\nPronto. O arquivo SQLite não foi alterado: ele continua ali, intacto, como backup.\n');
}

principal().catch(async (erro) => {
  console.error('\nFalhou:', erro.message, '\n');
  await encerrar().catch(() => {});
  process.exit(1);
});
