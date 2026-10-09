import { createHash } from 'crypto';

// Free-tier gateway validation for the OpenCode inference endpoints.
//
// Port of the oh-my-pi `zen-free-tier-headers` extension patch (which mirrors
// upstream PR #12326 `packages/ai/src/providers/inference-headers.ts`). The
// live gateway only accepts requests that carry:
//
//   - `User-Agent: opencode/<version>` (unless the caller set a `claude-cli/`
//     OAuth fingerprint, which stays authoritative, same as the PR)
//   - `x-opencode-session: ses_<hex:12><base62:14>` in canonical form
//   - `x-opencode-client` (verified working value: `desktop`)
//   - a JSON body with `stream: true` and at least ZEN_MIN_TOOL_NAMES core
//     OpenCode tool NAMES (`bash`, `read`, `edit`, `glob`, `grep`)
//   - the current `https://opencode.ai/inference/openai/…` path — the legacy
//     `https://opencode.ai/zen/…` path is rate-limited (429 FreeUsageLimitError)
//
// Unlike the pi patch this module never touches `globalThis.fetch`: the VS
// Code extension host is shared with other extensions, so the wrapper created
// by `createZenFetch` is passed explicitly to each AI SDK provider instead.
//
// Env:
//   ZEN_INJECT_TOOLS=0  — disable the tool-name injection (headers still patched)
//   ZEN_REWRITE_URL=0   — keep /zen/ URLs as-is (legacy 429 path)
//   ZEN_HEADERS_DEBUG=1 — console.debug one line per zen request

export const OPENCODE_USER_AGENT = 'opencode/1.18.31';

export const OPENCODE_CLIENT = 'desktop';

const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

const BASE62_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export const ZEN_REQUIRED_TOOL_NAMES = ['bash', 'read'];

export const ZEN_MIN_TOOL_NAMES = 2;

const LEGACY_PATH = '/zen/';
const CURRENT_PATH = '/inference/openai/';

export const STUB_DESCRIPTION =
	'Gateway-validation stub, NOT IMPLEMENTED. NEVER call this tool - any call ' +
	'fails; use a real registered tool instead.';

export const STUB_PARAMETERS: Record<string, unknown> = {
	type: 'object',
	properties: {
		command: { type: 'string', description: 'The command to execute' },
		timeout: { type: 'number', description: 'Optional timeout in milliseconds' },
		description: {
			type: 'string',
			description: 'Clear, concise description of what this command does in 5-10 words.',
		},
	},
	required: ['command'],
	additionalProperties: false,
};

// Canonicalize a session id into OpenCode's `ses_<hex:12><base62:14>` format,
// deterministic per input so turns keep attribution and prompt-cache affinity.
// Same scheme as PR #12326 (sha256 over `opencode\0omp\0<id>`).
export function canonicalizeSessionId(sessionId?: string): string {
	const id = sessionId?.trim();
	if (id && OPENCODE_SESSION_RE.test(id)) {
		return id;
	}
	const digest = createHash('sha256').update(`opencode\0omp\0${id || 'default'}`).digest();
	const timeHex = Buffer.from(digest.subarray(0, 6)).toString('hex');
	let randomPart = '';
	for (let i = 6; i < 20; i++) {
		randomPart += BASE62_CHARS[digest[i] % 62];
	}
	return `ses_${timeHex}${randomPart}`;
}

export function isZenUrl(url: string): boolean {
	try {
		const host = new URL(url).hostname.toLowerCase();
		return host === 'opencode.ai' || host.endsWith('.opencode.ai');
	} catch {
		return false;
	}
}

// Rewrite the legacy /zen/ gateway path to the current /inference/openai/.
// Models.dev still advertises the legacy path, so this runs transparently at
// fetch time; no registry or per-model changes needed.
export function rewriteZenUrl(url: string): { url: string; rewritten: boolean } {
	if (process.env.ZEN_REWRITE_URL === '0' || !url.includes(LEGACY_PATH)) {
		return { url, rewritten: false };
	}
	return { url: url.replace(LEGACY_PATH, CURRENT_PATH), rewritten: true };
}

function toolName(t: unknown): string | null {
	if (!t || typeof t !== 'object') {
		return null;
	}
	const rec = t as Record<string, unknown>;
	if (typeof rec.name === 'string') {
		return rec.name;
	}
	const fn = rec.function as Record<string, unknown> | undefined;
	return fn && typeof fn.name === 'string' ? fn.name : null;
}

function buildZenToolStub(url: string, tools: unknown[], name: string): Record<string, unknown> | null {
	if (url.includes('/responses')) {
		return { type: 'function', name, description: STUB_DESCRIPTION, parameters: STUB_PARAMETERS };
	}
	if (url.includes('/chat/completions')) {
		return {
			type: 'function',
			function: { name, description: STUB_DESCRIPTION, parameters: STUB_PARAMETERS },
		};
	}
	if (url.includes('/messages')) {
		return { name, description: STUB_DESCRIPTION, input_schema: STUB_PARAMETERS };
	}
	// Unknown envelope (e.g. google): clone the shape of an existing tool so
	// the gateway still counts the name. Without any tool to clone, fall back
	// to the chat-completions shape.
	const first = tools.find((t) => t && typeof t === 'object');
	if (first && typeof first === 'object') {
		const rec = first as Record<string, unknown>;
		if (typeof rec.name === 'string') {
			return { ...rec, name, description: STUB_DESCRIPTION };
		}
		const fn = rec.function as Record<string, unknown> | undefined;
		if (fn && typeof fn.name === 'string') {
			return { ...rec, function: { ...fn, name, description: STUB_DESCRIPTION } };
		}
	}
	return {
		type: 'function',
		function: { name, description: STUB_DESCRIPTION, parameters: STUB_PARAMETERS },
	};
}

function isForcedToolChoice(choice: unknown): boolean {
	if (choice === 'required' || choice === 'any') {
		return true;
	}
	if (choice && typeof choice === 'object' && !Array.isArray(choice) && 'type' in choice) {
		return choice.type === 'required' || choice.type === 'any';
	}
	return false;
}

// Append stubs for the missing required tool names to a zen JSON body until
// at least ZEN_MIN_TOOL_NAMES core names are present. Returns the original
// text untouched on any doubt (fail open).
export function injectZenTools(url: string, bodyText: string) {
	let doc: unknown;
	try {
		doc = JSON.parse(bodyText);
	} catch {
		return { text: bodyText, injected: [] as string[], present: 0 };
	}
	if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
		return { text: bodyText, injected: [] as string[], present: 0 };
	}
	const body = doc as Record<string, unknown>;
	const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : null;
	const names = (tools ?? []).map(toolName).filter((n): n is string => n !== null);
	const missing = ZEN_REQUIRED_TOOL_NAMES.filter((n) => !names.includes(n));
	const present = ZEN_REQUIRED_TOOL_NAMES.length - missing.length;
	// Enough names already, or a forced tool call that would make the model
	// invoke an unregistered stub for sure — leave such requests alone.
	const passthrough = { text: bodyText, injected: [] as string[], present };
	if (present >= ZEN_MIN_TOOL_NAMES || missing.length === 0 || isForcedToolChoice(body.tool_choice)) {
		return passthrough;
	}
	const stubs: Record<string, unknown>[] = [];
	for (const name of missing) {
		const stub = buildZenToolStub(url, tools ?? [], name);
		if (!stub) {
			return passthrough;
		}
		stubs.push(stub);
		if (present + stubs.length >= ZEN_MIN_TOOL_NAMES) {
			break;
		}
	}
	return {
		text: JSON.stringify({ ...body, tools: tools ? [...tools, ...stubs] : stubs }),
		injected: stubs.map((s) => toolName(s) ?? '?'),
		present,
	};
}

// Apply the PR #12326 header set onto a Headers instance, in place.
export function patchZenHeaders(headers: Headers, sessionId?: string): void {
	headers.set('x-opencode-session', canonicalizeSessionId(sessionId ?? headers.get('x-opencode-session') ?? undefined));
	if (!headers.get('user-agent')?.startsWith('claude-cli/')) {
		headers.set('user-agent', OPENCODE_USER_AGENT);
	}
	if (!headers.has('x-opencode-client')) {
		headers.set('x-opencode-client', OPENCODE_CLIENT);
	}
}

function debugLog(line: string): void {
	if (process.env.ZEN_HEADERS_DEBUG !== '1') {
		return;
	}
	console.debug(`[zen-free-tier-headers] ${line}`);
}

// Wrap a fetch implementation with the free-tier patch. Only absolute URLs on
// `opencode.ai` are touched; everything else passes through, and any internal
// error fails open to the base fetch.
export function createZenFetch(baseFetch: typeof fetch = fetch): typeof fetch {
	return (async function (
		this: unknown,
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1]
	): Promise<Response> {
		try {
			const rawUrl =
				typeof input === 'string'
					? input
					: input instanceof URL
						? input.href
						: (input as Request | undefined)?.url;
			if (typeof rawUrl !== 'string' || !isZenUrl(rawUrl)) {
				return baseFetch.call(this, input, init);
			}
			const { url, rewritten } = rewriteZenUrl(rawUrl);

			if (typeof input === 'string' || input instanceof URL) {
				const headers = new Headers(init?.headers);
				patchZenHeaders(headers);
				let body = init?.body;
				let injected: string[] = [];
				let present = 0;
				if (process.env.ZEN_INJECT_TOOLS !== '0' && typeof body === 'string' && body.trimStart().startsWith('{')) {
					const r = injectZenTools(url, body);
					injected = r.injected;
					present = r.present;
					if (injected.length > 0) {
						body = r.text;
						// Body grew — a stale explicit length would corrupt the request.
						headers.delete('content-length');
					}
				}
				debugLog(
					`${url.split('?')[0]}${rewritten ? ` (was ${rawUrl.split('?')[0]})` : ''} session=${(headers.get('x-opencode-session') ?? '?').slice(0, 18)} tools=${present} injected=[${injected.join(',')}]`
				);
				return baseFetch.call(this, url, { ...init, headers, body });
			}

			// Request object: merge request + init headers, patch, rebuild. Its
			// body is a stream, so tool injection (string bodies only) does not
			// apply here.
			const merged = new Headers((input as Request).headers);
			new Headers(init?.headers).forEach((v, k) => merged.set(k, v));
			patchZenHeaders(merged);
			const { headers: _drop, ...rest } = (init ?? {}) as RequestInit;
			void _drop;
			const req = new Request(url, {
				...(Object.keys(rest).length ? rest : {}),
				method: (input as Request).method,
				headers: merged,
				body: (input as Request).body,
				duplex: 'half',
			} as RequestInit);
			debugLog(
				`${url.split('?')[0]}${rewritten ? ` (was ${(input as Request).url.split('?')[0]})` : ''} session=${(merged.get('x-opencode-session') ?? '?').slice(0, 18)} request-input body-untouched`
			);
			return baseFetch.call(this, req, Object.keys(rest).length ? rest : undefined);
		} catch {
			// Fail open: never break a request because the patch hit something odd.
			return baseFetch.call(this, input, init);
		}
	} as typeof fetch);
}
