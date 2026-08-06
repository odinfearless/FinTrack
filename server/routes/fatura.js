import { Router } from 'express';
import multer from 'multer';
import { db } from '../db/index.js';
import { extrair, analisar } from '../services/leitorFatura.js';
import { despesasDoMes } from '../services/mes.js';
import { somarMeses, ehMes, mesAtual } from '../lib/mes.js';

export const fatura = Router();

const TIPOS_ACEITOS = /\.(pdf|png|jpe?g|webp|bmp|tiff?)$/i;

// Arquivo fica só em memória: uma fatura tem dados sensíveis e não há motivo
// para deixá-la em disco depois de lida.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_req, arquivo, cb) => {
    if (TIPOS_ACEITOS.test(arquivo.originalname)) return cb(null, true);
    const erro = new Error('Envie um PDF ou uma imagem (PNG, JPG, WEBP).');
    erro.status = 400; // sem isto o arquivo errado do usuário viraria erro 500
    return cb(erro);
  },
});

/**
 * Marca candidatos que já parecem existir no mês, para não importar em dobro.
 * A comparação usa as despesas já expandidas — assim uma parcela vinda de outro
 * mês também é reconhecida, não só os avulsos daquela competência.
 */
function marcarDuplicatas(itens, mes, cartaoId) {
  if (!cartaoId) return itens;

  const chave = (d, v) => `${String(d).toLowerCase().slice(0, 14)}|${Math.round(Number(v) * 100)}`;
  const jaTem = new Set(
    despesasDoMes(mes)
      .filter((d) => d.cartao_id === Number(cartaoId))
      .map((d) => chave(d.descricao, d.valor)),
  );

  return itens.map((i) => (jaTem.has(chave(i.descricao, i.valor))
    ? { ...i, duplicata: true, selecionado: false }
    : i));
}

/**
 * Etapa 1 — lê o arquivo e devolve os candidatos. Não grava nada.
 */
fatura.post('/ler', upload.single('arquivo'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo foi enviado.' });

    const mes = ehMes(req.body?.mes) ? req.body.mes : mesAtual();
    const cartaoId = req.body?.cartao_id ? Number(req.body.cartao_id) : null;

    const { linhas, origem, paginas, dimensoes, origemDaMarcacao, regioes: usadas } = await extrair(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
    );

    const categorias = db.prepare('SELECT id, nome FROM categorias').all();
    const { itens, descartadas, total_fatura: totalFatura } = analisar(linhas, { mes, categorias });

    return res.json({
      arquivo: req.file.originalname,
      origem,
      paginas,
      dimensoes,
      mes,
      cartao_id: cartaoId,
      marcacao: origemDaMarcacao || 'nenhuma',
      regioes_usadas: usadas?.length || 0,
      regioes: usadas || [],
      linhas_lidas: linhas.length,
      total_fatura: totalFatura,
      itens: marcarDuplicatas(itens, mes, cartaoId),
      descartadas: descartadas.slice(0, 40),
    });
  } catch (erro) {
    return next(erro);
  }
});

/**
 * Etapa 2 — grava o que o usuário revisou e confirmou.
 * Cada item vira compra avulsa ou parcelamento, conforme o tipo escolhido.
 */
fatura.post('/confirmar', (req, res, next) => {
  try {
    const { mes, cartao_id: cartaoId, itens } = req.body || {};

    if (!ehMes(mes)) return res.status(400).json({ erro: 'Informe o mês da fatura (AAAA-MM).' });
    if (!cartaoId) return res.status(400).json({ erro: 'Escolha o cartão em que os gastos entram.' });
    if (!Array.isArray(itens) || itens.length === 0) {
      return res.status(400).json({ erro: 'Selecione ao menos um lançamento para importar.' });
    }

    const cartao = db.prepare('SELECT id, nome FROM cartoes WHERE id = ?').get(cartaoId);
    if (!cartao) return res.status(404).json({ erro: 'Cartão não encontrado.' });

    const insLancamento = db.prepare(`
      INSERT INTO lancamentos (mes, data, cartao_id, categoria_id, pessoa_id, descricao, valor, observacao)
      VALUES (@mes, @data, @cartao_id, @categoria_id, @pessoa_id, @descricao, @valor, @observacao)`);
    const insParcelamento = db.prepare(`
      INSERT INTO parcelamentos (cartao_id, categoria_id, pessoa_id, descricao, valor_parcela, parcelas, mes_inicio, data_compra)
      VALUES (@cartao_id, @categoria_id, @pessoa_id, @descricao, @valor_parcela, @parcelas, @mes_inicio, @data_compra)`);
    const criados = { lancamentos: 0, parcelamentos: 0 };
    const ignorados = [];

    const gravar = db.transaction(() => {
      for (const item of itens) {
        const descricao = String(item.descricao || '').trim();
        const valor = Number(item.valor);

        if (!descricao || !Number.isFinite(valor) || valor === 0) {
          ignorados.push({ descricao: descricao || '(vazio)', motivo: 'descrição ou valor inválido' });
          continue;
        }

        const comum = {
          cartao_id: cartao.id,
          categoria_id: item.categoria_id || null,
          pessoa_id: item.pessoa_id || null,
          descricao,
        };

        if (item.tipo === 'parcelamento') {
          const parcelas = Number(item.parcelas);
          const atual = Number(item.parcela_atual) || 1;
          if (!Number.isFinite(parcelas) || parcelas < 1 || atual > parcelas) {
            ignorados.push({ descricao, motivo: 'número de parcelas inconsistente' });
            continue;
          }
          insParcelamento.run({
            ...comum,
            valor_parcela: valor,
            parcelas,
            // A fatura mostra a parcela atual; o cadastro guarda quando começou.
            mes_inicio: somarMeses(mes, -(atual - 1)),
            data_compra: item.data || null,
          });
          criados.parcelamentos += 1;
          continue;
        }

        insLancamento.run({
          ...comum,
          mes,
          data: item.data || null,
          valor,
          observacao: item.linha_original ? `Importado da fatura: ${item.linha_original}`.slice(0, 300) : null,
        });
        criados.lancamentos += 1;
      }
    });

    gravar();

    const total = criados.lancamentos + criados.parcelamentos;
    return res.json({ cartao: cartao.nome, mes, total, criados, ignorados });
  } catch (erro) {
    return next(erro);
  }
});
