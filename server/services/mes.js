import { db } from '../db/index.js';
import { diferencaMeses, somarMeses, intervalo } from '../lib/mes.js';

const arred = (n) => Math.round(n * 100) / 100;

const SELECT_CARTAO = `
  c.nome AS cartao, c.cor AS cartao_cor,
  cat.nome AS categoria, cat.cor AS categoria_cor,
  p.nome AS pessoa, p.reembolsa AS pessoa_reembolsa`;

// LEFT JOIN no cartão: o gasto avulso pode não ter um (Pix, dinheiro).
const JOINS = `
  LEFT JOIN cartoes    c   ON c.id   = t.cartao_id
  LEFT JOIN categorias cat ON cat.id = t.categoria_id
  LEFT JOIN pessoas    p   ON p.id   = t.pessoa_id`;

/**
 * Consulta preparada na primeira vez que é usada, e não ao carregar o módulo.
 *
 * O ESM avalia os imports antes do corpo de quem importa, então este arquivo é
 * lido antes de `migrar()` rodar lá no index.js. Preparando aqui em cima, um
 * banco novo nem abre — as tabelas ainda não existem — e um banco antigo quebra
 * assim que uma consulta mencionar tabela ou coluna criada pela migração.
 */
function consulta(sql) {
  let pronta = null;
  return () => {
    if (!pronta) pronta = db.prepare(sql);
    return pronta;
  };
}

const qAvulsos = consulta(`
  SELECT t.*, ${SELECT_CARTAO} FROM lancamentos t ${JOINS}
  WHERE t.mes = ? ORDER BY t.valor DESC`);

const qParcelamentos = consulta(`
  SELECT t.*, ${SELECT_CARTAO} FROM parcelamentos t ${JOINS}
  WHERE t.mes_inicio <= ? ORDER BY t.valor_parcela DESC`);

const qContas = consulta(`
  SELECT t.*, cat.nome AS categoria, cat.cor AS categoria_cor, cb.nome AS conta_bancaria
  FROM contas t
  LEFT JOIN categorias       cat ON cat.id = t.categoria_id
  LEFT JOIN contas_bancarias cb  ON cb.id  = t.conta_bancaria_id
  WHERE t.mes_inicio <= ? AND (t.mes_fim IS NULL OR t.mes_fim >= ?)
  ORDER BY t.valor DESC`);

const qReceitas = consulta(`
  SELECT t.*, cb.nome AS conta_bancaria
  FROM receitas t
  LEFT JOIN contas_bancarias cb ON cb.id = t.conta_bancaria_id
  WHERE t.mes_inicio <= ? AND (t.mes_fim IS NULL OR t.mes_fim >= ?)
  ORDER BY t.valor DESC`);

const qEncargos = consulta(`
  SELECT e.*, c.nome AS cartao FROM encargos e
  JOIN cartoes c ON c.id = e.cartao_id WHERE e.mes = ?`);

function base(linha, origem) {
  return {
    origem,
    ref_id: linha.id,
    chave: `${origem}:${linha.id}`,
    cartao_id: linha.cartao_id,
    cartao: linha.cartao,
    cartao_cor: linha.cartao_cor,
    categoria_id: linha.categoria_id,
    categoria: linha.categoria,
    categoria_cor: linha.categoria_cor,
    pessoa_id: linha.pessoa_id,
    pessoa: linha.pessoa,
    reembolsa: Boolean(linha.pessoa_id && linha.pessoa_reembolsa),
    descricao: linha.descricao,
  };
}

/**
 * Todas as despesas de cartão que caem no mês, já expandidas: o avulso vem
 * como está e o parcelamento vira a parcela daquela competência.
 */
export function despesasDoMes(mes) {
  const saida = [];

  for (const l of qAvulsos().all(mes)) {
    saida.push({
      ...base(l, 'avulso'),
      data: l.data,
      valor: l.valor,
      observacao: l.observacao,
      forma: l.forma,
    });
  }

  for (const p of qParcelamentos().all(mes)) {
    const indice = diferencaMeses(p.mes_inicio, mes); // 0 = primeira parcela
    if (indice < 0 || indice >= p.parcelas) continue;
    const restantes = p.parcelas - (indice + 1);
    saida.push({
      ...base(p, 'parcelamento'),
      data: p.data_compra,
      valor: p.valor_parcela,
      parcela_atual: indice + 1,
      parcelas: p.parcelas,
      parcelas_restantes: restantes,
      saldo_futuro: arred(restantes * p.valor_parcela),
      mes_inicio: p.mes_inicio,
      mes_fim: somarMeses(p.mes_inicio, p.parcelas - 1),
    });
  }

  return saida.sort((x, y) => y.valor - x.valor);
}

export function contasDoMes(mes) {
  return qContas().all(mes, mes).map((c) => ({
    ...c,
    recorrente: c.mes_fim === null || c.mes_fim !== c.mes_inicio,
  }));
}

export function receitasDoMes(mes) {
  return qReceitas().all(mes, mes).map((r) => ({
    ...r,
    recorrente: r.mes_fim === null || r.mes_fim !== r.mes_inicio,
  }));
}

function somar(itens, campo = 'valor') {
  return arred(itens.reduce((t, i) => t + i[campo], 0));
}

/** Consolidado do mês: é o que alimenta os cartões de indicador do painel. */
export function resumoDoMes(mes) {
  const despesas = despesasDoMes(mes);
  const contas = contasDoMes(mes);
  const receitas = receitasDoMes(mes);
  const encargos = qEncargos().all(mes);

  const porCartao = new Map();
  for (const c of db.prepare('SELECT * FROM cartoes WHERE ativo = 1 ORDER BY nome').all()) {
    porCartao.set(c.id, {
      cartao_id: c.id, cartao: c.nome, cor: c.cor, limite: c.limite,
      total: 0, encargos: 0, itens: 0, avulsos: 0, parcelamentos: 0,
    });
  }
  // Gastos fora de cartão (Pix, dinheiro, transferência) formam seu próprio
  // grupo. Sem ele, cairiam fora de qualquer balde e sumiriam do total do mês.
  const semCartao = {
    cartao_id: null, cartao: 'Sem cartão', cor: '#1baf7a', limite: null,
    total: 0, encargos: 0, itens: 0, avulsos: 0, parcelamentos: 0,
    formas: {},
  };

  for (const d of despesas) {
    const alvo = d.cartao_id ? porCartao.get(d.cartao_id) : semCartao;
    if (!alvo) continue;
    alvo.total = arred(alvo.total + d.valor);
    alvo.itens += 1;
    if (d.origem === 'avulso') alvo.avulsos = arred(alvo.avulsos + d.valor);
    if (d.origem === 'parcelamento') alvo.parcelamentos = arred(alvo.parcelamentos + d.valor);
    if (!d.cartao_id) {
      const forma = d.forma || 'Outros';
      semCartao.formas[forma] = arred((semCartao.formas[forma] || 0) + d.valor);
    }
  }
  for (const e of encargos) {
    const alvo = porCartao.get(e.cartao_id);
    if (!alvo) continue;
    alvo.encargos = e.valor;
    alvo.total = arred(alvo.total + e.valor);
  }

  const porCategoria = new Map();
  for (const d of [...despesas, ...contas]) {
    const nome = d.categoria || 'Sem categoria';
    const atual = porCategoria.get(nome) || { categoria: nome, cor: d.categoria_cor || '#898781', total: 0, itens: 0 };
    atual.total = arred(atual.total + d.valor);
    atual.itens += 1;
    porCategoria.set(nome, atual);
  }

  // Gasto de quem reembolsa entra como receita — é o mesmo efeito do SUMIF
  // por nome que a planilha usava para Joca e Taty.
  const porPessoa = new Map();
  for (const d of despesas.filter((x) => x.reembolsa)) {
    const atual = porPessoa.get(d.pessoa_id) || { pessoa_id: d.pessoa_id, pessoa: d.pessoa, total: 0, itens: 0 };
    atual.total = arred(atual.total + d.valor);
    atual.itens += 1;
    porPessoa.set(d.pessoa_id, atual);
  }
  const reembolsos = arred([...porPessoa.values()].reduce((t, p) => t + p.total, 0));

  const totalReceitas = somar(receitas);
  const rendaLiquida = arred(totalReceitas + reembolsos);
  const totalCartoes = arred([...porCartao.values()].reduce((t, c) => t + c.total, 0));
  const totalSemCartao = semCartao.total;
  const totalContas = somar(contas);
  const dividaTotal = arred(totalCartoes + totalSemCartao + totalContas);

  // Parcelas que ainda vencerão depois deste mês.
  const saldoFuturo = arred(
    despesas.filter((d) => d.origem === 'parcelamento').reduce((t, d) => t + d.saldo_futuro, 0),
  );

  return {
    mes,
    receitas: totalReceitas,
    reembolsos,
    renda_liquida: rendaLiquida,
    total_cartoes: totalCartoes,
    total_sem_cartao: totalSemCartao,
    total_contas: totalContas,
    divida_total: dividaTotal,
    saldo: arred(rendaLiquida - dividaTotal),
    comprometimento: rendaLiquida > 0 ? arred((dividaTotal / rendaLiquida) * 100) : null,
    saldo_futuro_parcelas: saldoFuturo,
    quantidade: {
      despesas: despesas.length,
      avulsos: despesas.filter((d) => d.origem === 'avulso').length,
      parcelamentos: despesas.filter((d) => d.origem === 'parcelamento').length,
      contas: contas.length,
    },
    por_cartao: [...porCartao.values()].sort((a, b) => b.total - a.total),
    sem_cartao: semCartao,
    por_categoria: [...porCategoria.values()].sort((a, b) => b.total - a.total),
    por_pessoa: [...porPessoa.values()].sort((a, b) => b.total - a.total),
    maiores: despesas.slice(0, 10),
  };
}

/** Projeção para os próximos meses, contando só o que já é conhecido hoje. */
export function projecao(mesInicial, quantidade = 6) {
  return intervalo(mesInicial, somarMeses(mesInicial, quantidade - 1)).map((m) => {
    const r = resumoDoMes(m);
    return {
      mes: m,
      renda_liquida: r.renda_liquida,
      divida_total: r.divida_total,
      saldo: r.saldo,
      total_cartoes: r.total_cartoes,
      total_contas: r.total_contas,
    };
  });
}

/** Competências que têm algum dado — usado para montar o seletor de mês. */
export function mesesComDados() {
  const linhas = db.prepare(`
    SELECT mes FROM lancamentos
    UNION SELECT mes_inicio FROM parcelamentos
    UNION SELECT mes_inicio FROM contas
    UNION SELECT mes_inicio FROM receitas
    UNION SELECT mes FROM encargos
    ORDER BY 1`).all();
  return linhas.map((l) => l.mes).filter(Boolean);
}
