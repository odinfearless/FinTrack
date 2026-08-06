/**
 * O recorte de "gastos deste cartão" usado tanto pela tela de cartões quanto
 * pelo `npm run limpar`. Fica em um lugar só de propósito: a prévia que o
 * usuário confere e o DELETE que roda em seguida precisam ser a mesma conta.
 *
 * Sem `mes`, o recorte é a vida inteira do cartão. Com `mes`, é o que pesa
 * naquela fatura — e aí vale lembrar que o parcelamento é uma linha só que
 * atravessa vários meses: apagar por causa de agosto tira também as parcelas de
 * setembro em diante. Quem quiser evitar isso passa `soAvulsos`.
 */
import path from 'node:path';
import { db, arquivoBanco } from '../db/index.js';
import { diferencaMeses } from '../lib/mes.js';

const arred = (n) => Math.round(n * 100) / 100;
const somar = (linhas) => arred(linhas.reduce((t, l) => t + (l.valor || 0), 0));

/** Um parcelamento entra no recorte do mês se alguma parcela cair nele. */
function parcelamentosNoMes(cartaoId, mes) {
  return db.prepare('SELECT * FROM parcelamentos WHERE cartao_id = ?').all(cartaoId)
    .filter((p) => {
      const i = diferencaMeses(p.mes_inicio, mes);
      return i >= 0 && i < p.parcelas;
    });
}

/**
 * Linhas que seriam apagadas, por tabela. O `valor` de cada linha é o peso que
 * ela tem no recorte: no mês, a parcela daquele mês; sem mês, a compra inteira.
 */
export function levantarLimpeza(cartaoId, { mes = null, soAvulsos = false } = {}) {
  const parcelamentos = soAvulsos ? []
    : (mes ? parcelamentosNoMes(cartaoId, mes)
      : db.prepare('SELECT * FROM parcelamentos WHERE cartao_id = ?').all(cartaoId));

  return {
    lancamentos: mes
      ? db.prepare('SELECT id, valor FROM lancamentos WHERE cartao_id = ? AND mes = ?').all(cartaoId, mes)
      : db.prepare('SELECT id, valor FROM lancamentos WHERE cartao_id = ?').all(cartaoId),

    parcelamentos: parcelamentos.map((p) => ({
      id: p.id,
      valor: arred(mes ? p.valor_parcela : p.valor_parcela * p.parcelas),
    })),

    encargos: mes
      ? db.prepare('SELECT id, valor FROM encargos WHERE cartao_id = ? AND mes = ?').all(cartaoId, mes)
      : db.prepare('SELECT id, valor FROM encargos WHERE cartao_id = ?').all(cartaoId),
  };
}

/** Contagem e soma por tabela, no formato que a tela mostra antes de confirmar. */
export function resumirLimpeza(alvo) {
  const itens = {};
  for (const [tabela, linhas] of Object.entries(alvo)) {
    itens[tabela] = { quantidade: linhas.length, total: somar(linhas) };
  }
  return {
    itens,
    quantidade: Object.values(itens).reduce((t, i) => t + i.quantidade, 0),
    total: arred(Object.values(itens).reduce((t, i) => t + i.total, 0)),
  };
}

/**
 * Apaga o recorte. Antes de mexer, grava uma cópia do banco em `data/` — é o
 * mesmo seguro que o script de linha de comando dá, e aqui vale mais ainda,
 * porque um clique é bem mais fácil de dar do que um comando com `--sim`.
 */
export function executarLimpeza(alvo) {
  const resumo = resumirLimpeza(alvo);
  if (resumo.quantidade === 0) return { ...resumo, backup: null };

  const carimbo = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backup = path.join(path.dirname(arquivoBanco), `backup-${carimbo}.db`);
  db.prepare('VACUUM INTO ?').run(backup);

  db.transaction(() => {
    for (const [tabela, linhas] of Object.entries(alvo)) {
      if (linhas.length === 0) continue;
      const stmt = db.prepare(`DELETE FROM ${tabela} WHERE id = ?`);
      linhas.forEach((l) => stmt.run(l.id));
    }
  })();

  return { ...resumo, backup };
}
