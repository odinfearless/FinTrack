-- ---------------------------------------------------------------------------
-- FinTrack — esquema do banco local (SQLite)
--
-- Convenção de vigência: quase toda entidade recorrente carrega o par
-- (mes_inicio, mes_fim) no formato 'YYYY-MM'. mes_fim NULL significa "vale
-- para sempre"; mes_fim = mes_inicio significa "só naquele mês". É esse par
-- que substitui o retrabalho de recadastrar tudo a cada aba nova da planilha.
-- ---------------------------------------------------------------------------

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS cartoes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  nome           TEXT    NOT NULL UNIQUE,
  emissor        TEXT,
  bandeira       TEXT,
  final          TEXT,
  cor            TEXT    NOT NULL DEFAULT '#2a78d6',
  limite         REAL,
  dia_fechamento INTEGER,
  dia_vencimento INTEGER,
  ativo          INTEGER NOT NULL DEFAULT 1,
  criado_em      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Conta corrente: é dela que saem os débitos e é nela que a receita cai.
-- O extrato traz saldo e limite num instante, e não uma série histórica, então
-- as três colunas guardam a última foto lida — `saldo_em` diz de quando ela é.
-- Nome do titular e CPF não entram: identificam a pessoa, não a conta.
CREATE TABLE IF NOT EXISTS contas_bancarias (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  nome         TEXT    NOT NULL UNIQUE,
  banco        TEXT,
  agencia      TEXT,
  numero       TEXT,
  cor          TEXT    NOT NULL DEFAULT '#f07c00',
  saldo        REAL,
  limite_total REAL,
  limite_usado REAL,
  saldo_em     TEXT,
  ativo        INTEGER NOT NULL DEFAULT 1,
  criado_em    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categorias (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT    NOT NULL UNIQUE,
  cor  TEXT    NOT NULL DEFAULT '#898781'
);

-- Pessoas cujos gastos entram na fatura mas são devolvidos depois.
-- Com reembolsa = 1 o total vira receita do mês, como o SUMIF da planilha fazia.
CREATE TABLE IF NOT EXISTS pessoas (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  nome      TEXT    NOT NULL UNIQUE,
  reembolsa INTEGER NOT NULL DEFAULT 1
);

-- Gasto avulso: vive em um único mês.
-- cartao_id é opcional: sem ele, o gasto saiu do bolso (Pix, transferência,
-- dinheiro) e quem diz como é a coluna `forma`.
-- conta_bancaria_id também é opcional, e só diz de onde o dinheiro saiu: quem
-- veio do extrato tem a conta preenchida, quem foi digitado à mão não precisa.
CREATE TABLE IF NOT EXISTS lancamentos (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  mes               TEXT    NOT NULL,
  data              TEXT,
  cartao_id         INTEGER          REFERENCES cartoes(id)          ON DELETE CASCADE,
  conta_bancaria_id INTEGER          REFERENCES contas_bancarias(id) ON DELETE SET NULL,
  forma             TEXT,
  categoria_id      INTEGER          REFERENCES categorias(id)       ON DELETE SET NULL,
  pessoa_id         INTEGER          REFERENCES pessoas(id)          ON DELETE SET NULL,
  descricao         TEXT    NOT NULL,
  valor             REAL    NOT NULL,
  observacao        TEXT,
  criado_em         TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (cartao_id IS NOT NULL OR forma IS NOT NULL)
);

-- Compra parcelada: uma linha só. As parcelas de cada mês são derivadas de
-- mes_inicio + parcelas, então nada precisa ser recopiado mês a mês.
CREATE TABLE IF NOT EXISTS parcelamentos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  cartao_id     INTEGER NOT NULL REFERENCES cartoes(id)    ON DELETE CASCADE,
  categoria_id  INTEGER          REFERENCES categorias(id) ON DELETE SET NULL,
  pessoa_id     INTEGER          REFERENCES pessoas(id)    ON DELETE SET NULL,
  descricao     TEXT    NOT NULL,
  valor_parcela REAL    NOT NULL,
  parcelas      INTEGER NOT NULL CHECK (parcelas >= 1),
  mes_inicio    TEXT    NOT NULL,
  data_compra   TEXT,
  observacao    TEXT,
  criado_em     TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Cobrança recorrente no cartão não tem tabela própria: ela é um gasto que se
-- repete, então entra como lançamento do mês. Fora do cartão, é uma conta.

-- Contas pagas fora do cartão (luz, água, débito automático).
CREATE TABLE IF NOT EXISTS contas (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  descricao         TEXT    NOT NULL,
  valor             REAL    NOT NULL,
  forma             TEXT    NOT NULL DEFAULT 'D.AUTO',
  categoria_id      INTEGER          REFERENCES categorias(id)       ON DELETE SET NULL,
  conta_bancaria_id INTEGER          REFERENCES contas_bancarias(id) ON DELETE SET NULL,
  dia_vencimento    INTEGER,
  mes_inicio        TEXT    NOT NULL,
  mes_fim           TEXT,
  criado_em         TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Receitas. Valor negativo é aceito de propósito: é assim que entram os
-- ajustes da planilha (cheque especial, juros do limite).
CREATE TABLE IF NOT EXISTS receitas (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  descricao         TEXT    NOT NULL,
  valor             REAL    NOT NULL,
  tipo              TEXT    NOT NULL DEFAULT 'fixa',
  conta_bancaria_id INTEGER          REFERENCES contas_bancarias(id) ON DELETE SET NULL,
  mes_inicio        TEXT    NOT NULL,
  mes_fim           TEXT,
  criado_em         TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Juros e encargos lançados na fatura de um mês específico.
CREATE TABLE IF NOT EXISTS encargos (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  mes       TEXT    NOT NULL,
  cartao_id INTEGER NOT NULL REFERENCES cartoes(id) ON DELETE CASCADE,
  valor     REAL    NOT NULL DEFAULT 0,
  UNIQUE (mes, cartao_id)
);

CREATE INDEX IF NOT EXISTS idx_lanc_mes        ON lancamentos (mes);
CREATE INDEX IF NOT EXISTS idx_lanc_cartao     ON lancamentos (cartao_id);
CREATE INDEX IF NOT EXISTS idx_parc_inicio     ON parcelamentos (mes_inicio);
CREATE INDEX IF NOT EXISTS idx_contas_vigencia ON contas (mes_inicio, mes_fim);
CREATE INDEX IF NOT EXISTS idx_receitas_vig    ON receitas (mes_inicio, mes_fim);
