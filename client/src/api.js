const BASE = '/api';

async function requisicao(caminho, opcoes = {}) {
  const resposta = await fetch(`${BASE}${caminho}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opcoes,
    body: opcoes.corpo === undefined ? undefined : JSON.stringify(opcoes.corpo),
  });

  if (resposta.status === 204) return null;

  const texto = await resposta.text();
  const dados = texto ? JSON.parse(texto) : null;
  if (!resposta.ok) {
    throw new Error(dados?.erro || `Falha na requisição (${resposta.status}).`);
  }
  return dados;
}

const query = (params = {}) => {
  const busca = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') busca.set(k, v);
  });
  const s = busca.toString();
  return s ? `?${s}` : '';
};

export const api = {
  get: (caminho, params) => requisicao(`${caminho}${query(params)}`),
  post: (caminho, corpo) => requisicao(caminho, { method: 'POST', corpo }),
  put: (caminho, corpo) => requisicao(caminho, { method: 'PUT', corpo }),
  del: (caminho) => requisicao(caminho, { method: 'DELETE' }),
};

/**
 * Envio de arquivo. Não passa pelo `requisicao` porque o navegador precisa
 * montar o Content-Type do multipart sozinho, com o boundary.
 */
export async function enviarArquivo(caminho, arquivo, campos = {}) {
  const dados = new FormData();
  dados.append('arquivo', arquivo);
  Object.entries(campos).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') dados.append(k, v);
  });

  const resposta = await fetch(`${BASE}${caminho}`, { method: 'POST', body: dados });
  const texto = await resposta.text();
  const corpo = texto ? JSON.parse(texto) : null;
  if (!resposta.ok) throw new Error(corpo?.erro || `Falha no envio (${resposta.status}).`);
  return corpo;
}

/** Um CRUD por recurso, para as telas não repetirem caminhos soltos. */
export const recurso = (nome) => ({
  listar: (params) => api.get(`/${nome}`, params),
  criar: (corpo) => api.post(`/${nome}`, corpo),
  atualizar: (id, corpo) => api.put(`/${nome}/${id}`, corpo),
  remover: (id) => api.del(`/${nome}/${id}`),
});
