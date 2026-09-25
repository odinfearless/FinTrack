/**
 * Classificar o que ficou sem categoria — em grupo, não um a um.
 *
 * Importação atrás de importação vai deixando gasto sem categoria, e a tela de
 * gastos não é boa para isso: ela mostra o mês, e o acervo atravessa todos. Mas
 * o trabalho é menor do que a contagem sugere, porque o mesmo estabelecimento
 * repete — cinco compras na Drogasil são cinco linhas e **uma** decisão.
 *
 * Daí o desenho: agrupar pela raiz do nome, sugerir o que o histórico souber, e
 * aplicar a categoria ao grupo inteiro de uma vez. Cada grupo resolvido também
 * alimenta o classificador, então a importação seguinte já chega classificada
 * sozinha. É esse laço que faz a sugestão melhorar com o uso.
 */
import { Router } from 'express';
import { db, transacao } from '../db/index.js';
import { raizDe, construirModelo, sugerir, resumirModelo } from '../services/classificador.js';

export const classificacao = Router();

// A raiz inteira separaria "drogasil4874carapicuiba" de
// "drogasil3953carapicuiba" — mesma rede, números de loja diferentes. O corte
// mantém a marca e descarta o que varia de uma loja para a outra.
const TAMANHO_DA_RAIZ = 12;

const chaveDoGrupo = (descricao) => raizDe(descricao).slice(0, TAMANHO_DA_RAIZ) || '(sem nome)';

/** Gastos sem categoria, agrupados por estabelecimento, com sugestão. */
classificacao.get('/pendentes', async (_req, res, next) => {
  try {
    const [pendentes, categorias, modelo] = [
      await db.prepare(`
        SELECT l.id, l.descricao, l.valor, l.mes, l.data, l.cartao_id, c.nome AS cartao
        FROM lancamentos l LEFT JOIN cartoes c ON c.id = l.cartao_id
        WHERE l.categoria_id IS NULL
        ORDER BY l.mes DESC, l.valor DESC`).all(),
      await db.prepare('SELECT id, nome FROM categorias').all(),
      await construirModelo(),
    ];

    const grupos = new Map();
    for (const item of pendentes) {
      const chave = chaveDoGrupo(item.descricao);
      if (!grupos.has(chave)) grupos.set(chave, []);
      grupos.get(chave).push(item);
    }

    const saida = [...grupos.entries()].map(([chave, itens]) => {
      // O cartão do grupo só é declarado quando todos vieram do mesmo: é ele
      // que habilita a chave por cartão da sugestão.
      const cartoes = new Set(itens.map((i) => i.cartao_id));
      const cartaoId = cartoes.size === 1 ? [...cartoes][0] : null;
      const sugestao = sugerir(modelo, itens[0].descricao, { cartaoId, categorias });

      return {
        chave,
        // A descrição mais longa costuma ser a menos truncada pelo OCR.
        rotulo: itens.map((i) => i.descricao).sort((a, b) => b.length - a.length)[0],
        cartao: cartaoId ? itens[0].cartao : null,
        quantidade: itens.length,
        total: Math.round(itens.reduce((t, i) => t + i.valor, 0) * 100) / 100,
        ids: itens.map((i) => i.id),
        exemplos: itens.slice(0, 5).map((i) => ({ id: i.id, descricao: i.descricao, valor: i.valor, mes: i.mes })),
        sugestao_id: sugestao?.categoria_id ?? null,
        sugestao_motivo: sugestao?.motivo ?? null,
        sugestao_confianca: sugestao?.confianca ?? null,
      };
    }).sort((a, b) => b.quantidade - a.quantidade || b.total - a.total);

    res.json({
      lancamentos: pendentes.length,
      grupos: saida.length,
      // Quantas decisões o agrupamento poupa — é o número que justifica a tela.
      decisoes_poupadas: pendentes.length - saida.length,
      modelo: resumirModelo(modelo),
      itens: saida,
    });
  } catch (erro) { next(erro); }
});

/** Aplica uma categoria a vários lançamentos de uma vez. */
classificacao.post('/aplicar', async (req, res, next) => {
  try {
    const grupos = Array.isArray(req.body?.grupos) ? req.body.grupos : [];
    if (grupos.length === 0) {
      return res.status(400).json({ erro: 'Escolha ao menos um grupo para classificar.' });
    }

    const validos = grupos
      .map((g) => ({
        categoriaId: Number(g.categoria_id),
        ids: (Array.isArray(g.ids) ? g.ids : []).map(Number).filter(Number.isInteger),
      }))
      .filter((g) => Number.isInteger(g.categoriaId) && g.ids.length > 0);

    if (validos.length === 0) {
      return res.status(400).json({ erro: 'Nenhum grupo veio com categoria e lançamentos válidos.' });
    }

    let atualizados = 0;
    await transacao(async (tx) => {
      const marcar = tx.prepare('UPDATE lancamentos SET categoria_id = ? WHERE id = ANY(?)');
      for (const g of validos) {
        const { changes } = await marcar.run(g.categoriaId, [g.ids]);
        atualizados += changes;
      }
    });

    return res.json({ grupos: validos.length, atualizados });
  } catch (erro) { return next(erro); }
});
