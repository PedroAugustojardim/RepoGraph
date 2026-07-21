// Erros e checagem de versão do motor (cgc), compartilhados entre o spawn curto
// (runEngineCommandSpawn/runQueryCommandSpawn) e o cliente MCP persistente (mcpClient.ts).

export function friendlyEngineError(stderr: string): string {
	if (stderr.includes('Could not set lock on file')) {
		// KuzuDB (banco embutido, tipo SQLite) só aceita uma conexão por vez.
		return 'O banco de dados está em uso por outra operação do cgc. Tente de novo em alguns segundos.';
	}
	return stderr.trim();
}

// Versão a partir da qual watch_directory/unwatch_directory/list_watched_paths existem
// de forma estável — mesma versão já declarada como testada no README da extensão.
export const MIN_ENGINE_VERSION = '0.5.1';

export function parseEngineVersion(versionOutput: string): [number, number, number] | null {
	const match = versionOutput.match(/(\d+)\.(\d+)\.(\d+)/);
	if (!match) {
		return null;
	}
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isEngineVersionSufficient(
	version: [number, number, number] | null,
	minVersion: string = MIN_ENGINE_VERSION,
): boolean {
	if (!version) {
		return false;
	}
	const min = parseEngineVersion(minVersion);
	if (!min) {
		return false;
	}
	for (let i = 0; i < 3; i++) {
		if (version[i] !== min[i]) {
			return version[i] > min[i];
		}
	}
	return true;
}
