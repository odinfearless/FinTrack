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

  /**
   * O id vem da URL e entra na consulta como parâmetro, nunca concatenado —
   * mas o Postgres é estrito com tipo, e comparar INTEGER com o texto "abc"
   * é erro de banco, não "não encontrado". Converter aqui transforma um id
   * inválido no 404 que ele sempre foi.
   */
  const idValido = (bruto) => {
    const n = Number(bruto);
    return Number.isInteger(n) ? n : null;
  };

  router.get('/', async (req, res, next) => {
    try {
      res.json(listar
        ? await listar(req.query)
        : await db.prepare(`SELECT * FROM ${tabela} ORDER BY ${ordem}`).all());
    } catch (erro) { next(erro); }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const id = idValido(req.params.id);
      const linha = id === null ? null : await buscar(id);
      if (!linha) return res.status(404).json({ erro: 'Registro não encontrado.' });
      return res.json(linha);
    } catch (erro) { return next(erro); }
  });

  router.post('/', async (req, res, next) => {
    try {
      const dados = filtrar(req.body || {}, campos, { exigirObrigatorios: true });
      if (aoSalvar) aoSalvar(dados, null);
      const usados = nomes.filter((n) => n in dados);
      // `RETURNING *` no lugar do `lastInsertRowid` do SQLite: o registro
      // gravado volta na mesma ida ao banco, sem um SELECT depois.
      const sql = `INSERT INTO ${tabela} (${usados.join(', ')})
                   VALUES (${usados.map((n) => `@${n}`).join(', ')})
                   RETURNING *`;
      const { linha } = await db.prepare(sql).run(dados);
      res.status(201).json(linha);
    } catch (erro) { next(erro); }
  });

  router.put('/:id', async (req, res, next) => {
    try {
      const id = idValido(req.params.id);
      const atual = id === null ? null : await buscar(id);
      if (!atual) return res.status(404).json({ erro: 'Registro não encontrado.' });
      const dados = filtrar(req.body || {}, campos, { exigirObrigatorios: false });
      if (aoSalvar) aoSalvar(dados, atual);
      const usados = nomes.filter((n) => n in dados);
      if (usados.length === 0) return res.json(atual);
      const sql = `UPDATE ${tabela} SET ${usados.map((n) => `${n} = @${n}`).join(', ')}
                   WHERE id = @id RETURNING *`;
      const { linha } = await db.prepare(sql).run({ ...dados, id });
      return res.json(linha);
    } catch (erro) { return next(erro); }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const id = idValido(req.params.id);
      const info = id === null
        ? { changes: 0 }
        : await db.prepare(`DELETE FROM ${tabela} WHERE id = ?`).run(id);
      if (info.changes === 0) return res.status(404).json({ erro: 'Registro não encontrado.' });
      return res.status(204).end();
    } catch (erro) { return next(erro); }
  });

  return router;
}
