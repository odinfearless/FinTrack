import { Router } from 'express';
import { db } from '../db/index.js';
import { criarCrud, tipos } from '../lib/crud.js';
import { ehMes } from '../lib/mes.js';
import { levantarLimpeza, resumirLimpeza, executarLimpeza } from '../services/limpezaCartao.js';

export const cartoes = criarCrud({
  tabela: 'cartoes',
  ordem: 'ativo DESC, nome',
  campos: {
    nome: tipos.texto({ obrigatorio: true, rotulo: 'Nome' }),
    emissor: tipos.texto({}),
    bandeira: tipos.texto({}),
    final: tipos.digitos({ tamanho: 4, rotulo: 'Final do cartão' }),
    cor: tipos.texto({ padrao: '#2a78d6' }),
    limite: tipos.numero({ min: 0 }),
    dia_fechamento: tipos.inteiro({ min: 1 }),
    dia_vencimento: tipos.inteiro({ min: 1 }),
    ativo: tipos.booleano({ padrao: 1 }),
  },
  listar: () => db.prepare(`
    SELECT c.*,
           (SELECT COUNT(*) FROM lancamentos   WHERE cartao_id = c.id) AS qtd_lancamentos,
           (SELECT COUNT(*) FROM parcelamentos WHERE cartao_id = c.id) AS qtd_parcelamentos
    FROM cartoes c ORDER BY c.ativo DESC, c.nome`).all(),
});

/**
 * Limpeza de gastos de um cartão, sem apagar o cadastro dele. É o mesmo recorte
 * do `npm run limpar`, exposto para a tela: o GET devolve a prévia que o
 * usuário confere e o POST apaga exatamente aquilo.
 */
function recorteDaRequisicao(req) {
  const mes = req.query.mes ?? req.body?.mes ?? null;
  if (mes && !ehMes(mes)) {
    const erro = new Error('Mês inválido. Use o formato AAAA-MM.');
    erro.status = 400;
    throw erro;
  }
  const bruto = req.query.so_avulsos ?? req.body?.so_avulsos;
  return { mes: mes || null, soAvulsos: bruto === true || bruto === '1' || bruto === 'true' };
}

function exigirCartao(id) {
  const cartao = db.prepare('SELECT id, nome FROM cartoes WHERE id = ?').get(id);
  if (!cartao) {
    const erro = new Error('Cartão não encontrado.');
    erro.status = 404;
    throw erro;
  }
  return cartao;
}

cartoes.get('/:id/limpeza', (req, res) => {
  const cartao = exigirCartao(req.params.id);
  const recorte = recorteDaRequisicao(req);
  res.json({ cartao, ...recorte, ...resumirLimpeza(levantarLimpeza(cartao.id, recorte)) });
});

cartoes.post('/:id/limpeza', (req, res) => {
  const cartao = exigirCartao(req.params.id);
  const recorte = recorteDaRequisicao(req);
  res.json({ cartao, ...recorte, ...executarLimpeza(levantarLimpeza(cartao.id, recorte)) });
});

export const categorias = criarCrud({
  tabela: 'categorias',
  ordem: 'nome',
  campos: {
    nome: tipos.texto({ obrigatorio: true, rotulo: 'Nome' }),
    cor: tipos.texto({ padrao: '#898781' }),
  },
  listar: () => db.prepare(`
    SELECT c.*,
           (SELECT COUNT(*) FROM lancamentos WHERE categoria_id = c.id) AS qtd_lancamentos
    FROM categorias c ORDER BY c.nome`).all(),
});

export const pessoas = criarCrud({
  tabela: 'pessoas',
  ordem: 'nome',
  campos: {
    nome: tipos.texto({ obrigatorio: true, rotulo: 'Nome' }),
    reembolsa: tipos.booleano({ padrao: 1 }),
  },
});

/** Encargos são chave (mes, cartao_id): a rota faz upsert em vez de duplicar. */
export const encargos = Router();

encargos.get('/', (req, res) => {
  const { mes } = req.query;
  const sql = `SELECT e.*, c.nome AS cartao FROM encargos e
               JOIN cartoes c ON c.id = e.cartao_id
               ${mes ? 'WHERE e.mes = ?' : ''} ORDER BY c.nome`;
  res.json(mes ? db.prepare(sql).all(mes) : db.prepare(sql).all());
});

encargos.put('/', (req, res) => {
  const { mes, cartao_id: cartaoId } = req.body || {};
  const valor = Number(req.body?.valor ?? 0);
  if (!/^\d{4}-\d{2}$/.test(String(mes)) || !cartaoId) {
    return res.status(400).json({ erro: 'Informe o mês (AAAA-MM) e o cartão.' });
  }
  db.prepare(`
    INSERT INTO encargos (mes, cartao_id, valor) VALUES (?, ?, ?)
    ON CONFLICT (mes, cartao_id) DO UPDATE SET valor = excluded.valor`)
    .run(mes, cartaoId, Number.isFinite(valor) ? valor : 0);
  return res.json(db.prepare('SELECT * FROM encargos WHERE mes = ? AND cartao_id = ?').get(mes, cartaoId));
});
