// Serializa toda operação que toca o motor (cgc), seja via spawn curto ou via
// conexão MCP persistente, para que a extensão nunca tenha dois processos
// próprios disputando o lock exclusivo do banco (KuzuDB) ao mesmo tempo.
//
// Sem isso, ligar o watch enquanto outra operação (ex: uma indexação de minutos)
// ainda está rodando via spawn viraria uma corrida contra o retry de lock do
// motor (que desiste depois de ~15s) em vez de uma espera confiável.
export class EngineGate {
	private tail: Promise<unknown> = Promise.resolve();

	run<T>(task: () => Promise<T>): Promise<T> {
		const result = this.tail.then(task, task);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}
