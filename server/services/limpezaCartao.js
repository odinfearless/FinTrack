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
import { db } from '../db/index.js';
import { diferencaMeses } from '../lib/mes.js';

// Resumir e apagar valem para qualquer recorte e vivem em `limpeza.js`. Saem
// daqui também para quem já importava deste arquivo não precisar mudar.
export { resumirLimpeza, executarLimpeza } from './limpeza.js';

const arred = (n) => Math.round(n * 100) / 100;

/** Um parcelamento entra no recorte do mês se alguma parcela cair nele. */
async function parcelamentosNoMes(cartaoId, mes) {
  return (await db.prepare('SELECT * FROM parcelamentos WHERE cartao_id = ?').all(cartaoId))
    .filter((p) => {
      const i = diferencaMeses(p.mes_inicio, mes);
      return i >= 0 && i < p.parcelas;
    });
}

/**
 * Linhas que seriam apagadas, por tabela. O `valor` de cada linha é o peso que
 * ela tem no recorte: no mês, a parcela daquele mês; sem mês, a compra inteira.
 */
export async function levantarLimpeza(cartaoId, { mes = null, soAvulsos = false } = {}) {
  let parcelamentos = [];
  if (!soAvulsos) {
    parcelamentos = mes
      ? await parcelamentosNoMes(cartaoId, mes)
      : await db.prepare('SELECT * FROM parcelamentos WHERE cartao_id = ?').all(cartaoId);
  }

  return {
    lancamentos: mes
      ? await db.prepare('SELECT id, valor FROM lancamentos WHERE cartao_id = ? AND mes = ?').all(cartaoId, mes)
      : await db.prepare('SELECT id, valor FROM lancamentos WHERE cartao_id = ?').all(cartaoId),

    parcelamentos: parcelamentos.map((p) => ({
      id: p.id,
      valor: arred(mes ? p.valor_parcela : p.valor_parcela * p.parcelas),
    })),

    encargos: mes
      ? await db.prepare('SELECT id, valor FROM encargos WHERE cartao_id = ? AND mes = ?').all(cartaoId, mes)
      : await db.prepare('SELECT id, valor FROM encargos WHERE cartao_id = ?').all(cartaoId),
  };
}

