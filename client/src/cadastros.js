import { api } from './api.js';
import { useDados } from './componentes.jsx';

/**
 * Cartões, categorias e pessoas — as três listas que quase todo formulário
 * precisa para montar seus selects.
 */
export function useCadastros() {
  return useDados(async () => {
    const [cartoes, categorias, pessoas] = await Promise.all([
      api.get('/cartoes'),
      api.get('/categorias'),
      api.get('/pessoas'),
    ]);
    return { cartoes, categorias, pessoas };
  }, []);
}

/** Selects de cartão/categoria/pessoa, iguais em todos os formulários. */
export function opcoesCartao(cartoes = []) {
  return cartoes.filter((c) => c.ativo).map((c) => ({ valor: c.id, texto: c.nome }));
}

export function opcoesCategoria(categorias = []) {
  return categorias.map((c) => ({ valor: c.id, texto: c.nome }));
}

export function opcoesPessoa(pessoas = []) {
  return pessoas.map((p) => ({ valor: p.id, texto: p.nome }));
}
