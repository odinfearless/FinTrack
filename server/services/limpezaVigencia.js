/**
 * O recorte de limpeza dos cadastros que valem por um período — contas e
 * receitas. Os dois têm a mesma forma (`valor`, `mes_inicio`, `mes_fim`,
 * `conta_bancaria_id`), então têm o mesmo recorte e a mesma armadilha.
 *
 * A armadilha é a vigência, e é ela que justifica a opção de preservar:
 * conta e receita são **cadastros**, não lançamentos de um mês. O salário
 * cadastrado em janeiro e sem data para acabar aparece em agosto por ser uma
 * linha só — apagá-lo porque agosto ficou errado o tira de janeiro a dezembro
 * junto, do mesmo jeito que apagar um parcelamento por causa de um mês.
 *
 * Por isso o recorte de um mês pergunta se é para levar só o que vale
 * **apenas** naquele mês. É esse recorte que desfaz uma importação de extrato
 * sem desmontar o que já estava certo.
 */
import { db } from '../db/index.js';
import { ehMes } from '../lib/mes.js';

// O nome da tabela entra na consulta por interpolação, então ele não pode vir
// da requisição: só destes dois valores, escritos aqui.
const TABELAS = new Set(['contas', 'receitas']);

/**
 * Linhas que seriam apagadas, no formato `{ tabela: [{ id, valor }] }` que
 * `resumirLimpeza` e `executarLimpeza` esperam.
 *
 * Sem `mes`, é tudo o que está cadastrado. Com `mes`, o que está vigente nele;
 * e com `soDoMes`, apenas o que começa e termina ali.
 */
export function levantarLimpezaVigencia(tabela, { mes = null, soDoMes = false, contaBancariaId = null } = {}) {
  if (!TABELAS.has(tabela)) throw new Error(`Tabela sem limpeza por vigência: ${tabela}`);

  const filtros = [];
  const valores = [];

  if (ehMes(mes)) {
    if (soDoMes) {
      filtros.push('mes_inicio = ? AND mes_fim = ?');
      valores.push(mes, mes);
    } else {
      filtros.push('mes_inicio <= ? AND (mes_fim IS NULL OR mes_fim >= ?)');
      valores.push(mes, mes);
    }
  }

  // Recorte por conta bancária: é o que permite desfazer a importação de um
  // extrato sem tocar no que foi cadastrado à mão ou veio de outro banco.
  if (contaBancariaId) {
    filtros.push('conta_bancaria_id = ?');
    valores.push(contaBancariaId);
  }

  const onde = filtros.length > 0 ? `WHERE ${filtros.join(' AND ')}` : '';
  return {
    [tabela]: db.prepare(`SELECT id, valor FROM ${tabela} ${onde} ORDER BY valor DESC`).all(...valores),
  };
}
