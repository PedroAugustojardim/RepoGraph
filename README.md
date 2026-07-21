# RepoGraph

Central de repositórios para IA: adicione seus projetos de código com um clique e o RepoGraph indexa cada um usando o [CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext) (um motor de análise de código que fala [MCP](https://modelcontextprotocol.io) nativamente). Qualquer assistente de IA compatível com MCP — Claude Code, Cursor, GitHub Copilot — passa a consultar esse mapa pronto de "quem chama o quê" em vez de precisar ler o código inteiro e adivinhar.

## Recursos

- **RepoGraph: Adicionar repositório** — escolhe uma pasta e dispara a indexação automaticamente.
- **RepoGraph: Remover repositório** — tira da lista e tenta apagar o índice correspondente no code graph.
- **Auto-atualização (watch)** — ícone de olho inline em cada repositório indexado: ativa o modo `cgc watch` do motor, que observa os arquivos e reindexa incrementalmente (só o arquivo mudado + quem o chama/herda dele) sem precisar reindexar manualmente. Pode ser ativado em vários repositórios ao mesmo tempo.
- **RepoGraph: Configurar integração MCP (IA)** — abre o assistente oficial do CodeGraphContext (`cgc mcp setup`) para registrar o servidor MCP no seu editor/CLI de IA.
- Barra lateral **"RepoGraph: Repositórios"** no Explorador, mostrando cada repositório cadastrado com status (pendente / indexado / erro) e o estado da auto-atualização (observando / sincronizando / erro).
- Painel de Output ("RepoGraph") com o log ao vivo de cada indexação.

## Requisitos

Esta extensão é só a "central de controle" — quem faz a leitura e o mapeamento do código é o [CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext), instalado separadamente:

```bash
pip install codegraphcontext
```

Testado com a versão `codegraphcontext==0.5.1`. Se a extensão detectar que o comando `cgc` não está disponível, ela avisa e oferece copiar o comando de instalação. A auto-atualização (watch) exige especificamente a versão `0.5.1` ou mais recente (é quando `watch_directory`/`unwatch_directory` passaram a existir no servidor MCP do motor); indexar/remover/consultar sem watch funciona em versões mais antigas.

No Windows, o backend de banco de dados padrão (FalkorDB Lite) não é compatível — troque para o KuzuDB (multiplataforma) antes de indexar:

```bash
cgc config db kuzudb
```

## Privacidade e segurança

- **Todo o processamento é local.** A indexação, o grafo e as consultas MCP acontecem inteiramente na sua máquina — nenhum código-fonte é enviado para servidores externos pela extensão ou pelo CodeGraphContext.
- **MCP via stdio**: a comunicação entre o cliente de IA e o servidor MCP roda por um canal interno entre processos, sem abrir porta de rede.
- **Segredos protegidos por padrão**: o CodeGraphContext ignora arquivos como `.env` mesmo sem `.gitignore`, além de respeitar o `.gitignore` do repositório.
- Todas as chamadas ao CLI do motor usam `spawn` com argumentos em array (nunca concatenação de string), evitando injeção de comando.
- Zero telemetria: a extensão não coleta nenhum dado de uso.

## Known Issues

- O motor rastreia **chamadas diretas de função**; padrões onde uma função é passada como referência (ex: middleware do Express, `router.use(minhaFuncao)`) podem não aparecer como "callers" na análise.
- A exclusão de um repositório do code graph (`cgc delete`) vem **desabilitada por padrão** no CodeGraphContext (`ALLOW_DB_DELETION=false`). Nesse caso, o RepoGraph remove o repositório da lista normalmente, mas avisa que o índice em si não pôde ser apagado.
- **Auto-atualização e o assistente de IA competem pelo mesmo banco.** O banco embarcado (KuzuDB, necessário no Windows) só aceita uma conexão de cada vez. Se o seu assistente de IA (Claude Code, Cursor, etc.) já tiver uma conexão MCP ativa com o CodeGraphContext no momento em que você tenta ativar o watch — ou vice-versa — a extensão mostra um erro claro em vez de travar ou tentar de novo sozinha; feche uma das duas conexões e tente de novo. Essa falha pode levar até ~15s para aparecer (o motor tenta destravar o banco antes de desistir).
- **Sem log ao vivo por arquivo.** A auto-atualização mostra o status "observando" por repositório, mas o motor não expõe um stream de eventos "arquivo X foi reindexado" — os logs de progresso incremental ficam suprimidos por padrão do lado do motor. Confie no status e, se precisar confirmar uma mudança específica, use **RepoGraph: Visualizar grafo em 3D** ou uma consulta manual.

## Release Notes

### 0.0.1

Versão inicial: adicionar/remover repositório, indexação via CodeGraphContext, configuração do servidor MCP, barra lateral com status e detecção de motor ausente.
