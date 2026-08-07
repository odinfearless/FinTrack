import { Router } from 'express';
import { db } from '../db/index.js';
import { criarCrud, tipos, ErroValidacao } from '../lib/crud.js';
import { despesasDoMes } from '../services/mes.js';
import { levantarLimpezaVigencia } from '../services/limpezaVigencia.js';
import { resumirLimpeza, executarLimpeza } from '../services/limpeza.js';
import { ehMes, mesAtual, somarMeses } from '../lib/mes.js';

const referencias = {
  cartao_id: tipos.inteiro({ obrigatorio: true, rotulo: 'Cartão' }),
  categoria_id: tipos.inteiro({}),
  pessoa_id: tipos.inteiro({}),
};

/** Formas de pagamento aceitas quando o gasto não passa por cartão. */
export const FORMAS_SEM_CARTAO = ['Pix', 'Transferência', 'Dinheiro', 'Boleto', 'Débito'];

export const lancamentos = criarCrud({
  tabela: 'lancamentos',
  ordem: 'mes DESC, valor DESC',
  campos: {
    mes: tipos.mes({ obrigatorio: true, rotulo: 'Mês' }),
    data: tipos.data({}),
    cartao_id: tipos.inteiro({}),
    conta_bancaria_id: tipos.inteiro({}),
    forma: tipos.texto({}),
    categoria_id: tipos.inteiro({}),
    pessoa_id: tipos.inteiro({}),
    descricao: tipos.texto({ obrigatorio: true, rotulo: 'Descrição' }),
    valor: tipos.numero({ obrigatorio: true, rotulo: 'Valor' }),
    observacao: tipos.texto({}),
  },
  aoSalvar: (dados, atual) => {
    // Depois do merge com o que já estava gravado, o gasto precisa ter uma
    // origem: ou o cartão, ou a forma de pagamento.
    const cartao = 'cartao_id' in dados ? dados.cartao_id : atual?.cartao_id;
    const forma = 'forma' in dados ? dados.forma : atual?.forma;
    if (!cartao && !forma) {
      throw new ErroValidacao('Escolha o cartão ou a forma de pagamento do gasto.');
    }
    // Com cartão, a forma não se aplica; sem cartão, ela é quem identifica.
    if (cartao) dados.forma = null;
    else if ('forma' in dados || !atual) dados.cartao_id = null;
  },
  listar: ({ mes }) => db.prepare(`
    SELECT l.*, c.nome AS cartao, c.cor AS cartao_cor, cat.nome AS categoria, p.nome AS pessoa,
           cb.nome AS conta_bancaria
    FROM lancamentos l
    LEFT JOIN cartoes          c   ON c.id  = l.cartao_id
    LEFT JOIN categorias       cat ON cat.id = l.categoria_id
    LEFT JOIN pessoas          p   ON p.id  = l.pessoa_id
    LEFT JOIN contas_bancarias cb  ON cb.id = l.conta_bancaria_id
    ${mes ? 'WHERE l.mes = ?' : ''}
    ORDER BY l.mes DESC, l.valor DESC`).all(...(mes ? [mes] : [])),
});

export const parcelamentos = criarCrud({
  tabela: 'parcelamentos',
  ordem: 'mes_inicio DESC',
  campos: {
    ...referencias,
    descricao: tipos.texto({ obrigatorio: true, rotulo: 'Descrição' }),
    // Sem piso: um estorno parcelado tem parcela negativa, e a importação de
    // fatura já grava linhas assim — travar aqui deixaria o registro existindo
    // no banco mas impossível de editar pela tela.
    valor_parcela: tipos.numero({ obrigatorio: true, rotulo: 'Valor da parcela' }),
    parcelas: tipos.inteiro({ obrigatorio: true, rotulo: 'Nº de parcelas', min: 1 }),
    mes_inicio: tipos.mes({ obrigatorio: true, rotulo: 'Mês da 1ª parcela' }),
    data_compra: tipos.data({}),
    observacao: tipos.texto({}),
  },
  listar: () => db.prepare(`
    SELECT p.*, c.nome AS cartao, c.cor AS cartao_cor, cat.nome AS categoria, pe.nome AS pessoa
    FROM parcelamentos p
    JOIN      cartoes    c   ON c.id   = p.cartao_id
    LEFT JOIN categorias cat ON cat.id = p.categoria_id
    LEFT JOIN pessoas    pe  ON pe.id  = p.pessoa_id
    ORDER BY p.mes_inicio DESC, p.valor_parcela DESC`).all(),
});

export const contas = criarCrud({
  tabela: 'contas',
  ordem: 'valor DESC',
  campos: {
    descricao: tipos.texto({ obrigatorio: true, rotulo: 'Descrição' }),
    valor: tipos.numero({ obrigatorio: true, rotulo: 'Valor' }),
    forma: tipos.texto({ padrao: 'D.AUTO' }),
    categoria_id: tipos.inteiro({}),
    conta_bancaria_id: tipos.inteiro({}),
    dia_vencimento: tipos.inteiro({ min: 1 }),
    mes_inicio: tipos.mes({ obrigatorio: true, rotulo: 'Início' }),
    mes_fim: tipos.mes({}),
  },
  listar: () => db.prepare(`
    SELECT c.*, cat.nome AS categoria, cb.nome AS conta_bancaria FROM contas c
    LEFT JOIN categorias       cat ON cat.id = c.categoria_id
    LEFT JOIN contas_bancarias cb  ON cb.id  = c.conta_bancaria_id
    ORDER BY (c.mes_fim IS NOT NULL), c.valor DESC`).all(),
});

export const receitas = criarCrud({
  tabela: 'receitas',
  ordem: 'valor DESC',
  campos: {
    descricao: tipos.texto({ obrigatorio: true, rotulo: 'Descrição' }),
    valor: tipos.numero({ obrigatorio: true, rotulo: 'Valor' }),
    tipo: tipos.texto({ padrao: 'fixa' }),
    conta_bancaria_id: tipos.inteiro({}),
    mes_inicio: tipos.mes({ obrigatorio: true, rotulo: 'Início' }),
    mes_fim: tipos.mes({}),
  },
  listar: () => db.prepare(`
    SELECT r.*, cb.nome AS conta_bancaria FROM receitas r
    LEFT JOIN contas_bancarias cb ON cb.id = r.conta_bancaria_id
    ORDER BY r.valor DESC`).all(),
});

/**
 * Limpeza de contas e de receitas.
 *
 * Mora num roteador próprio, e não em `/api/contas`, porque o CRUD daquele
 * recurso já registrou `/:id`: um `/contas/limpeza` cairia ali dentro, com
 * "limpeza" no lugar do id, e a rota nunca seria alcançada.
 *
 * O GET devolve a prévia que o usuário confere e o POST apaga exatamente
 * aquilo — os dois levantam o recorte pela mesma função.
 */
export const limpeza = Router();

function recorteDeVigencia(req) {
  const bruto = { ...req.query, ...(req.body || {}) };
  const mes = bruto.mes ?? null;

  if (mes && !ehMes(mes)) throw new ErroValidacao('Mês inválido. Use o formato AAAA-MM.');

  const ligado = (v) => v === true || v === 1 || v === '1' || v === 'true';
  const conta = Number(bruto.conta_bancaria_id);

  return {
    mes: mes || null,
    soDoMes: ligado(bruto.so_do_mes),
    contaBancariaId: Number.isFinite(conta) && conta > 0 ? conta : null,
  };
}

// Contas e receitas se apagam pelo mesmo recorte, então ganham o mesmo par de
// rotas. Escrever os dois handlers à mão só criaria a chance de a prévia e o
// DELETE divergirem em um dos recursos.
for (const tabela of ['contas', 'receitas']) {
  limpeza.get(`/${tabela}`, async (req, res, next) => {
    try {
      const recorte = recorteDeVigencia(req);
      res.json({ ...recorte, ...resumirLimpeza(await levantarLimpezaVigencia(tabela, recorte)) });
    } catch (erro) { next(erro); }
  });

  limpeza.post(`/${tabela}`, async (req, res, next) => {
    try {
      const recorte = recorteDeVigencia(req);
      res.json({ ...recorte, ...await executarLimpeza(await levantarLimpezaVigencia(tabela, recorte)) });
    } catch (erro) { next(erro); }
  });
}

/** Consulta unificada das despesas de cartão já expandidas para o mês. */
export const despesas = Router();

despesas.get('/', async (req, res, next) => {
  try {
  const mes = req.query.mes || mesAtual();
  const { cartao, categoria, pessoa, origem, q } = req.query;
  let itens = await despesasDoMes(mes);

  if (cartao === 'sem') itens = itens.filter((d) => !d.cartao_id);
  else if (cartao) itens = itens.filter((d) => String(d.cartao_id) === String(cartao));
  if (categoria) {
    itens = categoria === 'sem'
      ? itens.filter((d) => !d.categoria_id)
      : itens.filter((d) => String(d.categoria_id) === String(categoria));
  }
  if (pessoa) itens = itens.filter((d) => String(d.pessoa_id) === String(pessoa));
  if (origem) itens = itens.filter((d) => d.origem === origem);
  if (q) {
    const termo = String(q).toLowerCase();
    itens = itens.filter((d) => d.descricao.toLowerCase().includes(termo)
      || (d.categoria || '').toLowerCase().includes(termo)
      || (d.pessoa || '').toLowerCase().includes(termo));
  }

  res.json({
    mes,
    total: Math.round(itens.reduce((t, d) => t + d.valor, 0) * 100) / 100,
    quantidade: itens.length,
    itens,
  });
  } catch (erro) { next(erro); }
});

/** Antecipa a quitação de um parcelamento reduzindo o número de parcelas. */
despesas.post('/parcelamentos/:id/quitar', async (req, res, next) => {
  try {
  const id = Number(req.params.id);
  const parcelamento = Number.isInteger(id)
    ? await db.prepare('SELECT * FROM parcelamentos WHERE id = ?').get(id)
    : null;
  if (!parcelamento) return res.status(404).json({ erro: 'Parcelamento não encontrado.' });
  const mes = req.body?.mes || mesAtual();
  const pagas = Math.max(1, Math.min(
    parcelamento.parcelas,
    1 + (Number(mes.slice(0, 4)) * 12 + Number(mes.slice(5, 7)))
      - (Number(parcelamento.mes_inicio.slice(0, 4)) * 12 + Number(parcelamento.mes_inicio.slice(5, 7))),
  ));
  const { linha } = await db.prepare(
    'UPDATE parcelamentos SET parcelas = ? WHERE id = ? RETURNING *').run(pagas, id);
  return res.json({
    ...linha,
    ultima_parcela: somarMeses(parcelamento.mes_inicio, pagas - 1),
  });
  } catch (erro) { return next(erro); }
});
