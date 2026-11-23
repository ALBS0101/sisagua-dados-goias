# Dados abertos do SISAGUA — Goiás

Robô que, toda semana, baixa os dados abertos do SISAGUA (Ministério da Saúde) de Goiás, retira os dados
pessoais e publica um arquivo por município e ano, para o Painel SISAGUA do programa SISAGUA Consolidado.

- **O que publica:** controle mensal, controle semestral, captação, população e tratamento da Saneago, e as
  análises da Vigilância em Saúde (sistemas e soluções coletivas; as soluções individuais ficam de fora).
- **O que não publica:** nome, contato e registro de pessoas; endereço, descrição e coordenadas do local de coleta;
  nome e área das soluções coletivas (SAC) na vigilância, que podem identificar uma propriedade.
  Só saem as colunas da lista em `robo/sisagua-dados/formato.js`.
- **Não usa senha nenhuma** do SISAGUA, nem recebe dado do programa.
- **Fonte:** API e arquivos de Dados Abertos do SISAGUA, Ministério da Saúde. Os dados pertencem à fonte.

## Ligar (uma vez só)

1. Repositório **público**, com estes arquivos na branch principal.
2. **Settings → Pages → Source: GitHub Actions**.
3. **Actions → Atualizar dados → Run workflow**. A primeira vez baixa 5 anos e demora de 1 a 3 horas.
4. O endereço dos dados é `https://CONTA.github.io/REPOSITORIO/dados/`. É ele que vai em `painel/fonte.json`
   do SISAGUA Consolidado, antes de montar a versão.

Depois disso roda sozinho aos domingos. Os anos fechados são mantidos do site; para refazer um, use
**Run workflow** com o ano. Se o GitHub avisar que suspendeu o agendamento por falta de atividade, clique em
**Enable workflow** na aba Actions.

Os arquivos de `robo/` são cópias do projeto SISAGUA Consolidado (`ferramentas/`): mude lá e monte de novo.
