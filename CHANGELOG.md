# Change Log

All notable changes to the "RepoGraph" extension will be documented in this file.

## [0.2.0] - 2026-07-21

- **Auto-atualização via `cgc watch`**: novo ícone de olho inline em cada repositório indexado ativa/desativa o modo de observação de arquivos do motor — mudanças são reindexadas incrementalmente (só o arquivo alterado + quem o chama/herda dele) sem precisar reindexar manualmente. Pode ser ativado em vários repositórios ao mesmo tempo.
- A extensão passa a manter, sob demanda, sua própria conexão MCP persistente (`cgc mcp start` via stdio) enquanto pelo menos um repositório está em watch — todas as operações do motor (indexar/consultar/remover) passam a rotear por essa mesma conexão nesse período, para nunca disputar o lock exclusivo do banco (KuzuDB) com ela mesma. Sem nenhum repositório em watch, o comportamento continua idêntico ao anterior (processo curto por comando).
- Watch ativo sobrevive a reinícios do VSCode (retomado automaticamente na ativação) e é desligado automaticamente ao remover um repositório da lista.
- Erro claro (sem retry automático) quando o banco já está em uso por outra conexão MCP — cenário comum quando o assistente de IA configurado via `cgc mcp setup` já está conectado.
- Checagem best-effort de versão mínima do motor (`codegraphcontext >= 0.5.1`) antes de tentar ativar o watch pela primeira vez.

## [0.1.0] - 2026-07-20

- Ações inline na barra lateral de repositórios: ícone de **remover** (com confirmação) e clique no item para abrir o Output, sem precisar da paleta de comandos.
- Novo painel **"Grafo 3D"** (ícone próprio na Activity Bar) com um visualizador 3D nativo do grafo de código de cada repositório indexado, desenhado com cores do próprio tema do VSCode.
- Comandos **RepoGraph: Visualizar grafo em 3D** (paleta) e o ícone inline correspondente na árvore de repositórios.
- Correções de robustez descobertas numa revisão de segurança: vazamento de instâncias do renderizador 3D ao trocar de repositório, nomes de nós sem escape na tooltip, validação da resposta do `cgc query`, aviso quando o grafo é grande demais e é truncado, log da consulta no painel de Output, e proteção contra condição de corrida ao trocar de repositório rapidamente.
- Correção de uma letra de unidade (`C:` vs `c:`) inconsistente entre o VSCode e o CodeGraphContext que travava o banco KuzuDB em vez de simplesmente não retornar resultados.

## [0.0.1] - 2026-07-20

Versão inicial.

- Comando **RepoGraph: Adicionar repositório** — seleciona uma pasta, guarda numa lista persistente e dispara a indexação via CodeGraphContext.
- Comando **RepoGraph: Remover repositório** — remove da lista e tenta apagar o índice correspondente no code graph.
- Comando **RepoGraph: Configurar integração MCP (IA)** — abre o assistente oficial (`cgc mcp setup`) para registrar o servidor MCP no editor/CLI de IA.
- Barra lateral "RepoGraph: Repositórios" com status por repositório (pendente / indexado / erro).
- Painel de Output dedicado com o log ao vivo de cada indexação/remoção.
- Detecção de motor ausente na ativação, com atalho para copiar o comando de instalação.
- Timeout de 10 minutos para indexações travadas.
- Correção de um `UnicodeEncodeError` do CodeGraphContext no Windows (força `PYTHONIOENCODING=utf-8` no processo filho).
