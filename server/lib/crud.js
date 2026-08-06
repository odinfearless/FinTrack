import { Router } from 'express';
import { db } from '../db/index.js';

export class ErroValidacao extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.status = 400;
  }
}

/** Campos vindos do cliente que não estão na lista branca são descartados. */
function filtrar(corpo, campos, { exigirObrigatorios }) {
  const dados = {};
  for (const [nome, regra] of Object.entries(campos)) {
    const bruto = corpo[nome];
    const ausente = bruto === undefined || bruto === null || bruto === '';

    if (ausente) {
      if (regra.obrigatorio && exigirObrigatorios) {
        throw new ErroValidacao(`O campo "${regra.rotulo || nome}" é obrigatório.`);
      }
      if (!exigirObrigatorios && bruto === undefined) continue;
      if (regra.obrigatorio) continue;
      dados[nome] = regra.padrao !== undefined ? regra.padrao : null;
      continue;
    }

    dados[nome] = regra.transformar ? regra.transformar(bruto, regra, nome) : bruto;
  }
  return dados;
}

export const tipos = {
  texto: (regra) => ({
    ...regra,
    transformar: (v, r, nome) => {
      const s = String(v).trim();
      if (!s && r.obrigatorio) throw new ErroValidacao(`O campo "${r.rotulo || nome}" é obrigatório.`);
      return s;
    },
  }),
  numero: (regra) => ({
    ...regra,
    transformar: (v, r, nome) => {
      const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
      if (!Number.isFinite(n)) throw new ErroValidacao(`"${r.rotulo || nome}" precisa ser um número.`);
      if (r.min !== undefined && n < r.min) {
        throw new ErroValidacao(`"${r.rotulo || nome}" não pode ser menor que ${r.min}.`);
      }
      return n;
    },
  }),
  inteiro: (regra) => ({
    ...regra,
    transformar: (v, r, nome) => {
      const n = Math.trunc(Number(v));
      if (!Number.isFinite(n)) throw new ErroValidacao(`"${r.rotulo || nome}" precisa ser um número inteiro.`);
      if (r.min !== undefined && n < r.min) {
        throw new ErroValidacao(`"${r.rotulo || nome}" não pode ser menor que ${r.min}.`);
      }
      return n;
    },
  }),
  booleano: (regra) => ({ ...regra, transformar: (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0) }),
  digitos: (regra) => ({
    ...regra,
    transformar: (v, r, nome) => {
      const s = String(v).replace(/\D/g, '');
      if (r.tamanho && s.length !== r.tamanho) {
        throw new ErroValidacao(`"${r.rotulo || nome}" precisa ter ${r.tamanho} dígitos.`);
      }
      return s;
    },
  }),
  mes: (regra) => ({
    ...regra,
    transformar: (v, r, nome) => {
      const s = String(v).trim();
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) {
        throw new ErroValidacao(`"${r.rotulo || nome}" deve estar no formato AAAA-MM.`);
      }
      return s;
    },
  }),
  data: (regra) => ({
    ...regra,
    transformar: (v, r, nome) => {
      const s = String(v).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ErroValidacao(`"${r.rotulo || nome}" deve ser uma data válida.`);
      return s;
    },
  }),
};

/**
 * Monta um roteador REST completo para uma tabela.
 * `listar` permite trocar a consulta de GET / por uma versão com joins.
 */
export function criarCrud({ tabela, campos, ordem = 'id DESC', listar, aoSalvar }) {
  const router = Router();
  const nomes = Object.keys(campos);

  const buscar = (id) => db.prepare(`SELECT * FROM ${tabela} WHERE id = ?`).get(id);

  router.get('/', (req, res) => {
    res.json(listar ? listar(req.query) : db.prepare(`SELECT * FROM ${tabela} ORDER BY ${ordem}`).all());
  });

  router.get('/:id', (req, res) => {
    const linha = buscar(req.params.id);
    if (!linha) return res.status(404).json({ erro: 'Registro não encontrado.' });
    return res.json(linha);
  });

  router.post('/', (req, res) => {
    const dados = filtrar(req.body || {}, campos, { exigirObrigatorios: true });
    if (aoSalvar) aoSalvar(dados, null);
    const usados = nomes.filter((n) => n in dados);
    const sql = `INSERT INTO ${tabela} (${usados.join(', ')})
                 VALUES (${usados.map((n) => `@${n}`).join(', ')})`;
    const info = db.prepare(sql).run(dados);
    res.status(201).json(buscar(info.lastInsertRowid));
  });

  router.put('/:id', (req, res) => {
    const atual = buscar(req.params.id);
    if (!atual) return res.status(404).json({ erro: 'Registro não encontrado.' });
    const dados = filtrar(req.body || {}, campos, { exigirObrigatorios: false });
    if (aoSalvar) aoSalvar(dados, atual);
    const usados = nomes.filter((n) => n in dados);
    if (usados.length === 0) return res.json(atual);
    const sql = `UPDATE ${tabela} SET ${usados.map((n) => `${n} = @${n}`).join(', ')} WHERE id = @id`;
    db.prepare(sql).run({ ...dados, id: Number(req.params.id) });
    return res.json(buscar(req.params.id));
  });

  router.delete('/:id', (req, res) => {
    const info = db.prepare(`DELETE FROM ${tabela} WHERE id = ?`).run(req.params.id);
    if (info.changes === 0) return res.status(404).json({ erro: 'Registro não encontrado.' });
    return res.status(204).end();
  });

  return router;
}
