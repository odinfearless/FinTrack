import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pastaDados = path.join(raiz, 'data');

/**
 * Instalação nova nasce como `fintrack.db`. Quem já usava o app quando ele se
 * chamava AppGastos continua no `appgastos.db` — renomear o arquivo de dados de
 * alguém não é tarefa do código; se quiser trocar, é só renomear os três
 * arquivos (`.db`, `-wal`, `-shm`) com o servidor parado.
 */
function bancoPadrao() {
  const anterior = path.join(pastaDados, 'appgastos.db');
  return fs.existsSync(anterior) ? anterior : path.join(pastaDados, 'fintrack.db');
}

const arquivo = process.env.FINTRACK_DB || process.env.APPGASTOS_DB || bancoPadrao();

fs.mkdirSync(path.dirname(arquivo), { recursive: true });

export const db = new Database(arquivo);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Colunas acrescentadas depois que bancos já existiam. O `CREATE TABLE IF NOT
 * EXISTS` do schema não altera tabela criada, então elas precisam entrar por
 * ALTER — sem isso, quem já usava o app ficaria sem o campo novo.
 */
const COLUNAS_NOVAS = [
  ['cartoes', 'final', 'TEXT'],
];

function garantirColunas() {
  for (const [tabela, coluna, tipo] of COLUNAS_NOVAS) {
    const existe = db.prepare(`PRAGMA table_info(${tabela})`).all().some((c) => c.name === coluna);
    if (!existe) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${tipo}`);
  }
}

/**
 * Torna `lancamentos.cartao_id` opcional em bancos criados antes de existirem
 * gastos sem cartão. O SQLite não afrouxa um NOT NULL por ALTER TABLE, então a
 * única saída é reconstruir a tabela e copiar as linhas.
 */
function permitirGastoSemCartao() {
  const colunas = db.prepare('PRAGMA table_info(lancamentos)').all();
  const cartao = colunas.find((c) => c.name === 'cartao_id');
  if (!cartao || cartao.notnull === 0) return;

  const tinha = db.prepare('SELECT COUNT(*) AS n FROM lancamentos').get().n;

  // As chaves ficam desligadas durante a troca: o DROP da tabela antiga
  // dispararia o ON DELETE CASCADE e levaria junto os dados que estão sendo
  // migrados. Elas voltam logo em seguida, e a contagem confere o resultado.
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE lancamentos_novo (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      mes          TEXT    NOT NULL,
      data         TEXT,
      cartao_id    INTEGER          REFERENCES cartoes(id)     ON DELETE CASCADE,
      forma        TEXT,
      categoria_id INTEGER          REFERENCES categorias(id)  ON DELETE SET NULL,
      pessoa_id    INTEGER          REFERENCES pessoas(id)     ON DELETE SET NULL,
      descricao    TEXT    NOT NULL,
      valor        REAL    NOT NULL,
      observacao   TEXT,
      criado_em    TEXT    NOT NULL DEFAULT (datetime('now')),
      CHECK (cartao_id IS NOT NULL OR forma IS NOT NULL)
    );
    INSERT INTO lancamentos_novo
      (id, mes, data, cartao_id, forma, categoria_id, pessoa_id, descricao, valor, observacao, criado_em)
    SELECT id, mes, data, cartao_id, NULL, categoria_id, pessoa_id, descricao, valor, observacao, criado_em
    FROM lancamentos;
    DROP TABLE lancamentos;
    ALTER TABLE lancamentos_novo RENAME TO lancamentos;
    CREATE INDEX IF NOT EXISTS idx_lanc_mes    ON lancamentos (mes);
    CREATE INDEX IF NOT EXISTS idx_lanc_cartao ON lancamentos (cartao_id);
  `);
  db.pragma('foreign_keys = ON');

  const agora = db.prepare('SELECT COUNT(*) AS n FROM lancamentos').get().n;
  if (agora !== tinha) {
    throw new Error(`Migração perdeu lançamentos: ${tinha} antes, ${agora} depois.`);
  }
  console.log(`FinTrack • lançamentos agora aceitam gasto sem cartão (${agora} registros preservados)`);
}

export function migrar() {
  const schema = fs.readFileSync(path.join(raiz, 'server', 'db', 'schema.sql'), 'utf8');
  db.exec(schema);
  garantirColunas();
  permitirGastoSemCartao();
}

/** Popula categorias e cartões básicos na primeira execução. */
export function semear() {
  const temCategorias = db.prepare('SELECT COUNT(*) AS n FROM categorias').get().n;
  if (temCategorias > 0) return false;

  const categorias = [
    ['Mercado', '#1baf7a'],
    ['Ifood', '#eb6834'],
    ['Combustível', '#eda100'],
    ['Uber', '#4a3aa7'],
    ['Saúde', '#e34948'],
    ['Compras online', '#2a78d6'],
    ['Assinaturas', '#e87ba4'],
    ['Educação', '#008300'],
    ['Casa', '#898781'],
    ['Lazer', '#d55181'],
  ];
  const insCat = db.prepare('INSERT INTO categorias (nome, cor) VALUES (?, ?)');
  const tx = db.transaction(() => categorias.forEach((c) => insCat.run(c)));
  tx();
  return true;
}

export const arquivoBanco = arquivo;
