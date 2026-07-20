# Change Log

All notable changes to the "RepoGraph" extension will be documented in this file.

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
