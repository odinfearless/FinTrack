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
import fs from 'node:fs';
import path from 'node:path';
import { db, transacao, pastaDados } from '../db/index.js';

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
 * Guarda o que vai ser apagado, em JSON, dentro de `data/`.
 *
 * No SQLite isto era um `VACUUM INTO`: uma cópia do arquivo inteiro do banco,
 * barata porque o banco era um arquivo. O Postgres não tem equivalente que o
 * app possa chamar sozinho — o `pg_dump` é um binário externo, que pode não
 * existir na máquina nem na imagem.
 *
 * A troca acabou sendo melhor para o que o backup serve. Ninguém restaura um
 * banco inteiro por causa de três contas apagadas por engano; quer as três
 * linhas de volta. O arquivo traz cada registro removido com todas as colunas,
 * pronto para reinserir.
 */
async function guardarCopia(alvo) {
  const registros = {};
  for (const [tabela, linhas] of Object.entries(alvo)) {
    if (linhas.length === 0) continue;
    const ids = linhas.map((l) => l.id);
    registros[tabela] = await db.prepare(`SELECT * FROM ${tabela} WHERE id = ANY(?)`).all([ids]);
  }

  const carimbo = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const destino = path.join(pastaDados, `backup-${carimbo}.json`);
  fs.writeFileSync(destino, JSON.stringify({ removido_em: new Date().toISOString(), registros }, null, 2));
  return destino;
}

/**
 * Apaga o recorte. Antes de mexer, guarda o que sai — é o mesmo seguro que o
 * script de linha de comando dá, e aqui vale mais ainda, porque um clique é bem
 * mais fácil de dar do que um comando com `--sim`.
 */
export async function executarLimpeza(alvo) {
  const resumo = resumirLimpeza(alvo);
  if (resumo.quantidade === 0) return { ...resumo, backup: null };

  const backup = await guardarCopia(alvo);

  await transacao(async (tx) => {
    for (const [tabela, linhas] of Object.entries(alvo)) {
      if (linhas.length === 0) continue;
      // Um DELETE por tabela, com a lista inteira: o Postgres cobra uma ida ao
      // banco por instrução, e um DELETE por linha faria centenas delas.
      await tx.prepare(`DELETE FROM ${tabela} WHERE id = ANY(?)`).run([linhas.map((l) => l.id)]);
    }
  });

  return { ...resumo, backup };
}
