import { Router } from 'express';
import { db } from '../db/index.js';
import { criarCrud, tipos, ErroValidacao } from '../lib/crud.js';
import { despesasDoMes } from '../services/mes.js';
import { mesAtual, somarMeses } from '../lib/mes.js';

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
    SELECT l.*, c.nome AS cartao, c.cor AS cartao_cor, cat.nome AS categoria, p.nome AS pessoa
    FROM lancamentos l
    LEFT JOIN cartoes    c   ON c.id   = l.cartao_id
    LEFT JOIN categorias cat ON cat.id = l.categoria_id
    LEFT JOIN pessoas    p   ON p.id   = l.pessoa_id
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
    dia_vencimento: tipos.inteiro({ min: 1 }),
    mes_inicio: tipos.mes({ obrigatorio: true, rotulo: 'Início' }),
    mes_fim: tipos.mes({}),
  },
  listar: () => db.prepare(`
    SELECT c.*, cat.nome AS categoria FROM contas c
    LEFT JOIN categorias cat ON cat.id = c.categoria_id
    ORDER BY (c.mes_fim IS NOT NULL), c.valor DESC`).all(),
});

export const receitas = criarCrud({
  tabela: 'receitas',
  ordem: 'valor DESC',
  campos: {
    descricao: tipos.texto({ obrigatorio: true, rotulo: 'Descrição' }),
    valor: tipos.numero({ obrigatorio: true, rotulo: 'Valor' }),
    tipo: tipos.texto({ padrao: 'fixa' }),
    mes_inicio: tipos.mes({ obrigatorio: true, rotulo: 'Início' }),
    mes_fim: tipos.mes({}),
  },
});

/** Consulta unificada das despesas de cartão já expandidas para o mês. */
export const despesas = Router();

despesas.get('/', (req, res) => {
  const mes = req.query.mes || mesAtual();
  const { cartao, categoria, pessoa, origem, q } = req.query;
  let itens = despesasDoMes(mes);

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
});

/** Antecipa a quitação de um parcelamento reduzindo o número de parcelas. */
despesas.post('/parcelamentos/:id/quitar', (req, res) => {
  const parcelamento = db.prepare('SELECT * FROM parcelamentos WHERE id = ?').get(req.params.id);
  if (!parcelamento) return res.status(404).json({ erro: 'Parcelamento não encontrado.' });
  const mes = req.body?.mes || mesAtual();
  const pagas = Math.max(1, Math.min(
    parcelamento.parcelas,
    1 + (Number(mes.slice(0, 4)) * 12 + Number(mes.slice(5, 7)))
      - (Number(parcelamento.mes_inicio.slice(0, 4)) * 12 + Number(parcelamento.mes_inicio.slice(5, 7))),
  ));
  db.prepare('UPDATE parcelamentos SET parcelas = ? WHERE id = ?').run(pagas, req.params.id);
  return res.json({
    ...db.prepare('SELECT * FROM parcelamentos WHERE id = ?').get(req.params.id),
    ultima_parcela: somarMeses(parcelamento.mes_inicio, pagas - 1),
  });
});
