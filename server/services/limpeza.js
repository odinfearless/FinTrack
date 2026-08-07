/**
 * A parte de apagar que é igual para todo recorte de limpeza.
 *
 * Cada tipo de limpeza — os gastos de um cartão, as contas do mês — só precisa
 * dizer **quais linhas** saem, no formato `{ tabela: [{ id, valor }] }`. Resumir
 * e apagar é o mesmo trabalho nos dois casos, e é o que mora aqui.
 *
 * Manter esse par junto é proposital: a prévia que o usuário confere e o DELETE
 * que roda em seguida precisam ser a mesma conta, sobre a mesma lista. Se cada
 * limpeza levantasse a sua e apagasse por outra consulta, a tela poderia
 * prometer três registros e o banco levar trinta.
 */
import path from 'node:path';
import { db, arquivoBanco } from '../db/index.js';

const arred = (n) => Math.round(n * 100) / 100;
const somar = (linhas) => arred(linhas.reduce((t, l) => t + (l.valor || 0), 0));

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
