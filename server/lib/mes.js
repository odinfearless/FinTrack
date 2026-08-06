/**
 * Utilitários para o formato de competência 'YYYY-MM'.
 * Como a string é ordenável lexicograficamente, as comparações viram `<=` / `>=`
 * direto no SQL — nenhuma conversão de data no banco.
 */

export const RX_MES = /^\d{4}-(0[1-9]|1[0-2])$/;

export function ehMes(valor) {
  return typeof valor === 'string' && RX_MES.test(valor);
}

export function mesAtual(agora = new Date()) {
  return `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}`;
}

/** Soma (ou subtrai, com n negativo) meses a uma competência. */
export function somarMeses(mes, n) {
  const [ano, m] = mes.split('-').map(Number);
  const total = ano * 12 + (m - 1) + n;
  const novoAno = Math.floor(total / 12);
  const novoMes = (total % 12) + 1;
  return `${String(novoAno).padStart(4, '0')}-${String(novoMes).padStart(2, '0')}`;
}

/** Quantidade de meses de `de` até `ate` (negativo se `ate` for anterior). */
export function diferencaMeses(de, ate) {
  const [a1, m1] = de.split('-').map(Number);
  const [a2, m2] = ate.split('-').map(Number);
  return (a2 * 12 + m2) - (a1 * 12 + m1);
}

/** Lista de competências de `de` até `ate`, inclusive. */
export function intervalo(de, ate) {
  const saida = [];
  const total = diferencaMeses(de, ate);
  for (let i = 0; i <= total; i += 1) saida.push(somarMeses(de, i));
  return saida;
}

const NOMES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

export function rotulo(mes) {
  const [ano, m] = mes.split('-').map(Number);
  const nome = NOMES[m - 1];
  return `${nome.charAt(0).toUpperCase()}${nome.slice(1)} de ${ano}`;
}

/** Converte o nome de uma aba da planilha ('Agosto') em competência. */
export function mesDeNome(nome, ano) {
  const i = NOMES.indexOf(String(nome).trim().toLowerCase());
  return i < 0 ? null : `${ano}-${String(i + 1).padStart(2, '0')}`;
}
