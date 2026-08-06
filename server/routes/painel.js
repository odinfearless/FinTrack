import { Router } from 'express';
import { db } from '../db/index.js';
import { resumoDoMes, projecao, mesesComDados, contasDoMes, receitasDoMes } from '../services/mes.js';
import { mesAtual, ehMes, somarMeses, intervalo } from '../lib/mes.js';

export const painel = Router();

painel.get('/meses', (_req, res) => {
  const existentes = mesesComDados();
  const hoje = mesAtual();
  // Sempre oferece o mês corrente e os dois seguintes, mesmo sem lançamento.
  const conhecidos = new Set([...existentes, hoje, somarMeses(hoje, 1), somarMeses(hoje, 2)]);
  const ordenados = [...conhecidos].sort();
  const completos = ordenados.length > 1
    ? intervalo(ordenados[0], ordenados[ordenados.length - 1])
    : ordenados;
  res.json({ atual: hoje, meses: completos, com_dados: existentes });
});

painel.get('/resumo', (req, res) => {
  const mes = ehMes(req.query.mes) ? req.query.mes : mesAtual();
  const resumo = resumoDoMes(mes);
  const anterior = resumoDoMes(somarMeses(mes, -1));
  res.json({
    ...resumo,
    comparativo: {
      mes: anterior.mes,
      divida_total: anterior.divida_total,
      renda_liquida: anterior.renda_liquida,
      saldo: anterior.saldo,
      variacao_divida: anterior.divida_total > 0
        ? Math.round(((resumo.divida_total - anterior.divida_total) / anterior.divida_total) * 1000) / 10
        : null,
    },
  });
});

painel.get('/projecao', (req, res) => {
  const mes = ehMes(req.query.mes) ? req.query.mes : mesAtual();
  const meses = Math.min(Math.max(Number(req.query.meses) || 6, 1), 24);
  res.json({ mes, meses, linhas: projecao(mes, meses) });
});

painel.get('/mes/:mes', (req, res) => {
  const { mes } = req.params;
  if (!ehMes(mes)) return res.status(400).json({ erro: 'Mês inválido. Use o formato AAAA-MM.' });
  return res.json({
    resumo: resumoDoMes(mes),
    contas: contasDoMes(mes),
    receitas: receitasDoMes(mes),
  });
});

/** Números globais para a tela de configurações / diagnóstico. */
painel.get('/estatisticas', (_req, res) => {
  const contar = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  res.json({
    cartoes: contar('cartoes'),
    categorias: contar('categorias'),
    pessoas: contar('pessoas'),
    lancamentos: contar('lancamentos'),
    parcelamentos: contar('parcelamentos'),
    contas: contar('contas'),
    receitas: contar('receitas'),
    meses: mesesComDados().length,
  });
});
