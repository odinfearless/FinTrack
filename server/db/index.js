/**
 * Acesso ao PostgreSQL.
 *
 * O app nasceu em SQLite, com o `better-sqlite3`, que é **síncrono**: o código
 * inteiro chamava `db.prepare(sql).all(...)` e recebia as linhas na hora. O
 * driver do Postgres é assíncrono, e não há como contornar isso — o que muda o
 * grafo de chamadas inteiro para `async`.
 *
 * O que dá para evitar é reescrever todo o SQL. Este módulo expõe a mesma forma
 * de antes — `prepare(sql)` com `.all()`, `.get()` e `.run()` — só que
 * retornando promessas, e traduz na borda as duas diferenças de sintaxe:
 *
 *   `?` e `@nome`  →  `$1..$n`, que é a única forma que o Postgres aceita
 *   NUMERIC/BIGINT →  número, porque o driver os entrega como string
 *
 * A conversão de NUMERIC é o detalhe que mais importa. O `pg` devolve
 * `NUMERIC` como string para não perder precisão, e o app soma dinheiro o tempo
 * todo: sem o conversor, `total + linha.valor` viraria concatenação de texto e
 * o painel mostraria "0123.45" em vez de 168,45 — um erro silencioso, do tipo
 * que só aparece depois, no total do mês.
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { raizProjeto } from '../lib/caminhos.js';

/* ------------------------------ tipos ------------------------------------- */

const paraNumero = (v) => (v === null ? null : Number(v));

// NUMERIC e BIGINT (o COUNT(*) devolve bigint) chegam como string. O app faz
// aritmética com número em toda parte, então a conversão é aqui, uma vez, e não
// espalhada em `Number(...)` por dezenas de pontos de leitura.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, paraNumero);
pg.types.setTypeParser(pg.types.builtins.INT8, paraNumero);

/* ---------------------------- conexão ------------------------------------- */

export const pastaDados = path.join(raizProjeto, 'data');
fs.mkdirSync(pastaDados, { recursive: true });

const url = process.env.DATABASE_URL
  || `postgres://${process.env.PGUSER || 'fintrack'}:${process.env.PGPASSWORD || 'fintrack'}`
   + `@${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || 5432}`
   + `/${process.env.PGDATABASE || 'fintrack'}`;

export const pool = new pg.Pool({
  connectionString: url,
  // O app é de uso pessoal e roda um processo só; um punhado de conexões é
  // folgado e evita segurar slots do Postgres à toa.
  max: Number(process.env.PGPOOL_MAX) || 10,
  idleTimeoutMillis: 30_000,
});

// Sem este ouvinte, um erro em conexão ociosa (o banco reiniciou, o container
// caiu) derruba o processo inteiro com uma exceção não tratada.
pool.on('error', (erro) => console.error('FinTrack • erro em conexão ociosa:', erro.message));

/** Como o banco aparece no diagnóstico, sem a senha junto. */
export const descricaoBanco = url.replace(/\/\/([^:]+):[^@]*@/, '//$1@');

/* --------------------------- tradução do SQL ------------------------------ */

/**
 * Converte os marcadores do SQLite nos do Postgres.
 *
 * Duas formas convivem no código, porque o `better-sqlite3` aceitava as duas:
 * `?` posicional, com os valores soltos, e `@nome`, com um objeto. Traduzir as
 * duas aqui é o que permitiu manter o SQL de todas as rotas como estava.
 *
 * O `@nome` repetido vira dois `$n` diferentes com o mesmo valor. É mais
 * verboso do que precisaria ser, e é de propósito: reaproveitar o índice exige
 * rastrear quais nomes já saíram, e o ganho seria nenhum.
 */
export function compilar(sql, args) {
  if (sql.includes('@')) {
    const objeto = args[0] || {};
    const valores = [];
    const texto = sql.replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, nome) => {
      valores.push(objeto[nome] === undefined ? null : objeto[nome]);
      return `$${valores.length}`;
    });
    return { texto, valores };
  }

  // `.all(a, b)` e `.all([a, b])` valiam as duas no driver antigo.
  const soltos = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  let n = 0;
  const texto = sql.replace(/\?/g, () => { n += 1; return `$${n}`; });
  return { texto, valores: soltos.slice(0, n) };
}

/**
 * Monta a interface familiar sobre qualquer executor — o pool, para consultas
 * soltas, ou um cliente preso, dentro de uma transação. É por receber o
 * executor de fora que a mesma interface serve aos dois casos.
 */
function interfaceDe(consultar) {
  const rodar = (sql, args) => {
    const { texto, valores } = compilar(sql, args);
    // Sem parâmetros o `pg` usa o protocolo simples, que aceita várias
    // instruções numa string só — é dele que o `exec` do esquema depende.
    return consultar(texto, valores.length > 0 ? valores : undefined);
  };

  return {
    prepare: (sql) => ({
      all: async (...args) => (await rodar(sql, args)).rows,
      get: async (...args) => (await rodar(sql, args)).rows[0],
      /**
       * `changes` continua com o nome de antes, para os pontos que só querem
       * saber se algo foi afetado. `linha` é a novidade útil: com um
       * `RETURNING`, é por ela que sai o registro recém-criado — o Postgres não
       * tem o `lastInsertRowid` do SQLite.
       */
      run: async (...args) => {
        const r = await rodar(sql, args);
        return { changes: r.rowCount, linha: r.rows[0] };
      },
    }),
    /** Várias instruções de uma vez, para DDL. Não aceita parâmetros. */
    exec: (sql) => consultar(sql),
  };
}

export const db = interfaceDe((texto, valores) => pool.query(texto, valores));

/**
 * Bloco tudo-ou-nada.
 *
 * O `db.transaction(fn)` do SQLite embrulhava uma função síncrona; aqui a
 * função recebe um `tx` com a mesma interface, e é **ele** que precisa ser
 * usado lá dentro. Usar o `db` global dentro da transação pegaria outra conexão
 * do pool, que está fora dela — as escritas ficariam de fora do COMMIT e um
 * ROLLBACK não as desfaria.
 */
export async function transacao(fn) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const resultado = await fn(interfaceDe((texto, valores) => cliente.query(texto, valores)));
    await cliente.query('COMMIT');
    return resultado;
  } catch (erro) {
    await cliente.query('ROLLBACK');
    throw erro;
  } finally {
    cliente.release();
  }
}

/* ---------------------------- migração ------------------------------------ */

/**
 * Colunas acrescentadas depois que bancos já existiam.
 *
 * No SQLite isto exigia consultar o `PRAGMA table_info` antes de cada ALTER. O
 * Postgres tem `IF NOT EXISTS`, então a lista vira uma instrução por linha e a
 * verificação some.
 */
const COLUNAS_NOVAS = [
  ['cartoes', 'final', 'TEXT'],
  ['lancamentos', 'conta_bancaria_id', 'INTEGER REFERENCES contas_bancarias(id) ON DELETE SET NULL'],
  ['contas', 'conta_bancaria_id', 'INTEGER REFERENCES contas_bancarias(id) ON DELETE SET NULL'],
  ['receitas', 'conta_bancaria_id', 'INTEGER REFERENCES contas_bancarias(id) ON DELETE SET NULL'],
];

export async function migrar() {
  const schema = fs.readFileSync(path.join(raizProjeto, 'server', 'db', 'schema.sql'), 'utf8');
  await db.exec(schema);
  for (const [tabela, coluna, tipo] of COLUNAS_NOVAS) {
    await db.exec(`ALTER TABLE ${tabela} ADD COLUMN IF NOT EXISTS ${coluna} ${tipo}`);
  }
}

/**
 * Espera o banco aceitar conexão.
 *
 * No Docker o app sobe junto do Postgres, e o `depends_on` só garante que o
 * container iniciou — não que o servidor já esteja ouvindo. Sem esta espera, a
 * primeira subida do ambiente morre no primeiro `migrar()`.
 */
export async function esperarBanco({ tentativas = 30, intervalo = 1000 } = {}) {
  for (let i = 1; i <= tentativas; i += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (erro) {
      if (i === tentativas) throw new Error(`Banco não respondeu em ${tentativas}s: ${erro.message}`);
      await new Promise((r) => { setTimeout(r, intervalo); });
    }
  }
}

/** Popula categorias básicas na primeira execução. */
export async function semear() {
  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM categorias').get();
  if (n > 0) return false;

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

  await transacao(async (tx) => {
    for (const [nome, cor] of categorias) {
      await tx.prepare('INSERT INTO categorias (nome, cor) VALUES (?, ?)').run(nome, cor);
    }
  });
  return true;
}

/**
 * Realinha as sequences de `id` com o maior id de cada tabela.
 *
 * Depois de uma carga que insere ids explícitos — a migração vinda do SQLite —,
 * a sequence continua no zero e o primeiro cadastro feito pela tela colidiria
 * com um id que já existe.
 */
export async function realinharSequences() {
  const tabelas = ['cartoes', 'contas_bancarias', 'categorias', 'pessoas',
    'lancamentos', 'parcelamentos', 'contas', 'receitas', 'encargos'];
  for (const tabela of tabelas) {
    await db.exec(`
      SELECT setval(
        pg_get_serial_sequence('${tabela}', 'id'),
        COALESCE((SELECT MAX(id) FROM ${tabela}), 1),
        (SELECT MAX(id) IS NOT NULL FROM ${tabela})
      )`);
  }
}

export async function encerrar() {
  await pool.end();
}
