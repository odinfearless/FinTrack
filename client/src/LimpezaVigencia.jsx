import { useState } from 'react';
import { api } from './api.js';
import { brl, rotuloMes } from './formato.js';
import {
  Campo, Estado, Modal, useDados,
} from './componentes.jsx';

/**
 * Apagar contas ou receitas em lote.
 *
 * Os dois cadastros têm a mesma forma — valem por um período, têm valor e podem
 * vir de uma conta bancária —, então têm o mesmo recorte e a mesma armadilha. O
 * que muda entre eles é só o texto, e é só isso que esta tabela guarda: manter
 * duas telas quase iguais faria uma receber correção que a outra não recebe.
 *
 * A prévia vem do servidor a cada mudança de recorte, e é ela — não o texto do
 * botão — que diz o que vai sumir. É o mesmo desenho da limpeza de cartão, pela
 * mesma razão: um clique é fácil demais de dar para não haver conferência.
 */
const TEXTOS = {
  contas: {
    titulo: 'Limpar contas e débitos',
    singular: 'conta',
    plural: 'contas',
    rotuloTabela: 'Contas e débitos',
    intocado: 'cartões, gastos e receitas não são tocados',
    escopoTudo: 'Todas as contas cadastradas',
    avisoTudo: 'Isso apaga todas as contas de todos os meses, recorrentes inclusive — luz, água, '
      + 'aluguel, o que estiver cadastrado. O painel de cada mês perde essa parte da dívida.',
    avisoRecorrente: 'Ela aparece nesse mês por ser uma linha só que vale em vários meses — '
      + 'apagá-la aqui a remove de todos eles.',
  },
  receitas: {
    titulo: 'Limpar receitas',
    singular: 'receita',
    plural: 'receitas',
    rotuloTabela: 'Receitas',
    intocado: 'cartões, gastos e contas não são tocados',
    escopoTudo: 'Todas as receitas cadastradas',
    avisoTudo: 'Isso apaga todas as receitas de todos os meses, o salário recorrente inclusive. '
      + 'Sem receita, a renda líquida de cada mês vai a zero e o comprometimento deixa de ser '
      + 'calculado — o painel fica sem o outro lado da conta.',
    avisoRecorrente: 'Ela aparece nesse mês por ser uma linha só que vale em vários meses — '
      + 'apagá-la aqui a remove de todos eles, inclusive dos meses já fechados.',
  },
};

export default function ModalLimpezaVigencia({
  recurso, mes, contasBancarias = [], aoFechar, aoConcluir,
}) {
  const texto = TEXTOS[recurso];
  const [escopo, setEscopo] = useState('mes');
  const [competencia, setCompetencia] = useState(mes);
  const [soDoMes, setSoDoMes] = useState(true);
  const [contaBancariaId, setContaBancariaId] = useState('');
  const [apagando, setApagando] = useState(false);
  const [erro, setErro] = useState(null);

  // Com o campo de mês vazio a busca não sai: sem o recorte, o servidor
  // responderia por tudo e a prévia mentiria sobre o que vai sumir.
  const mesValido = escopo !== 'mes' || /^\d{4}-(0[1-9]|1[0-2])$/.test(competencia || '');

  const previa = useDados(
    () => (mesValido
      ? api.get(`/limpeza/${recurso}`, {
        mes: escopo === 'mes' ? competencia : undefined,
        so_do_mes: escopo === 'mes' && soDoMes ? '1' : undefined,
        conta_bancaria_id: contaBancariaId || undefined,
      })
      : null),
    [recurso, escopo, competencia, soDoMes, contaBancariaId],
  );

  const apagar = async () => {
    setApagando(true);
    setErro(null);
    try {
      aoConcluir(await api.post(`/limpeza/${recurso}`, {
        mes: escopo === 'mes' ? competencia : null,
        so_do_mes: escopo === 'mes' && soDoMes,
        conta_bancaria_id: contaBancariaId || null,
      }));
    } catch (e) {
      setErro(e.message);
      setApagando(false);
    }
  };

  const quantidade = previa.dados?.quantidade;

  const rotuloBotao = () => {
    if (!mesValido) return 'Informe o mês';
    if (quantidade === undefined) return 'Apagar';
    if (quantidade === 0) return 'Nada a apagar';
    return `Apagar ${quantidade} ${quantidade === 1 ? texto.singular : texto.plural}`;
  };

  return (
    <Modal
      aberto
      titulo={texto.titulo}
      aoFechar={aoFechar}
      aoSalvar={apagar}
      salvando={apagando}
      salvarDesabilitado={!mesValido || !quantidade || previa.carregando}
      erro={erro}
      perigo
      rotuloSalvar={rotuloBotao()}
      rotuloSalvando="Apagando…"
    >
      <p style={{ margin: '0 0 14px', fontSize: 13.5, color: 'var(--text-2)' }}>
        Saem só as {texto.plural} — {texto.intocado}. Uma cópia do banco é gravada
        em <code>data/</code> antes de apagar.
      </p>

      <Campo rotulo="O que apagar">
        <select value={escopo} onChange={(e) => setEscopo(e.target.value)}>
          <option value="mes">Só um mês</option>
          <option value="tudo">{texto.escopoTudo}</option>
        </select>
      </Campo>

      {escopo === 'mes' && (
        <>
          <Campo rotulo="Mês" dica={`Começa no mês aberto na tela (${rotuloMes(mes, { curto: true })})`}>
            <input type="month" value={competencia} onChange={(e) => setCompetencia(e.target.value)} />
          </Campo>
          <div className="linha-check">
            <input
              id="limpeza-so-do-mes"
              type="checkbox"
              checked={soDoMes}
              onChange={(e) => setSoDoMes(e.target.checked)}
            />
            <label htmlFor="limpeza-so-do-mes">
              Só as que valem apenas neste mês (mantém as recorrentes)
            </label>
          </div>
        </>
      )}

      {contasBancarias.length > 0 && (
        <Campo
          rotulo="Só as de uma conta bancária"
          dica="Para desfazer a importação de um extrato sem tocar no resto"
        >
          <select value={contaBancariaId} onChange={(e) => setContaBancariaId(e.target.value)}>
            <option value="">Qualquer origem</option>
            {contasBancarias.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
          </select>
        </Campo>
      )}

      {escopo === 'mes' && !soDoMes && quantidade > 0 && (
        <div className="aviso" style={{ marginTop: 12 }}>
          <b>Cadastro recorrente não pertence a um mês só.</b>{' '}
          {texto.avisoRecorrente} Marque a opção acima para preservá-los.
        </div>
      )}

      {escopo === 'tudo' && (
        <div className="aviso" style={{ marginTop: 12 }}>{texto.avisoTudo}</div>
      )}

      <div style={{ marginTop: 16 }}>
        <div className="rotulo" style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 6 }}>
          O que será apagado
        </div>
        <Estado carregando={previa.carregando} erro={previa.erro}>
          {previa.dados && (
            <div className="rolagem">
              <table>
                <thead>
                  <tr><th>Tipo</th><th className="num">Registros</th><th className="num">Valor</th></tr>
                </thead>
                <tbody>
                  <tr className={quantidade === 0 ? 'fraco' : undefined}>
                    <td>{texto.rotuloTabela}</td>
                    <td className="num">{quantidade}</td>
                    <td className="num">{brl(previa.dados.total)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </Estado>
        <div className="dica" style={{ marginTop: 6 }}>
          {escopo === 'mes'
            ? `${texto.rotuloTabela} vigentes em ${rotuloMes(competencia, { curto: true })}, pelo valor cadastrado.`
            : `Todas as ${texto.plural}, pelo valor cadastrado em cada uma.`}
        </div>
      </div>
    </Modal>
  );
}
