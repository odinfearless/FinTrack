import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { importarPlanilha } from '../services/importador.js';
import { raizProjeto } from '../lib/caminhos.js';

export const importacao = Router();

// A planilha é lida em memória e descartada: o que interessa dela já foi para o
// banco, e guardar uma cópia no disco só criaria um arquivo esquecido.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (_req, arquivo, cb) => {
    if (/\.xlsx?$/i.test(arquivo.originalname)) return cb(null, true);
    const erro = new Error('Envie uma planilha .xlsx ou .xls.');
    erro.status = 400; // sem isto o arquivo errado do usuário viraria erro 500
    return cb(erro);
  },
});

/** Planilhas .xlsx disponíveis na raiz do projeto, prontas para importar. */
importacao.get('/planilhas', (_req, res) => {
  const arquivos = fs.readdirSync(raizProjeto)
    .filter((f) => /\.xlsx?$/i.test(f) && !f.startsWith('~$'))
    .map((f) => {
      const info = fs.statSync(path.join(raizProjeto, f));
      return { arquivo: f, tamanho: info.size, modificado: info.mtime.toISOString() };
    });
  res.json({ pasta: raizProjeto, arquivos });
});

/** Importação de uma planilha enviada pela tela. */
importacao.post('/arquivo', upload.single('arquivo'), (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo foi enviado.' });
    return res.json(importarPlanilha({
      conteudo: req.file.buffer,
      nome: req.file.originalname,
      ano: req.body?.ano ? Number(req.body.ano) : undefined,
      substituir: String(req.body?.substituir) !== 'false',
    }));
  } catch (erro) {
    return next(erro);
  }
});

importacao.post('/', (req, res, next) => {
  try {
    const nome = req.body?.arquivo;
    if (!nome) return res.status(400).json({ erro: 'Informe o nome do arquivo da planilha.' });
    // Só arquivos da raiz do projeto: nada de subir a árvore de diretórios.
    const alvo = path.join(raizProjeto, path.basename(String(nome)));
    const relatorio = importarPlanilha({
      arquivo: alvo,
      ano: req.body?.ano ? Number(req.body.ano) : undefined,
      substituir: req.body?.substituir !== false,
    });
    return res.json(relatorio);
  } catch (erro) {
    return next(erro);
  }
});
