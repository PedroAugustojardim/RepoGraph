# Change Log

All notable changes to the "RepoGraph" extension will be documented in this file.

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
