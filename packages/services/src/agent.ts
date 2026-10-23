import type {
  AssetBundle,
  AssetRequest,
  TerrainEditDraft,
  TerrainEditRequest,
} from '@chrona/protocol';
import { hashString } from '@chrona/world';
import { box, compileAssetScript, type AssetSpec } from './assetScript.js';
import { ROOM_ITEMS } from './room.js';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

/** Runs local tools on behalf of the model (tools execute client-side). */
export interface ToolHost {
  specs: ToolSpec[];
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface ChatTransport {
  readonly name: string;
  chat(messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatMessage>;
}

export interface CodeAgent {
  readonly name: string;
  createAsset(request: AssetRequest): Promise<AssetBundle>;
  createTerrainEdit(request: TerrainEditRequest): Promise<TerrainEditDraft>;
}

/**
 * Offline stand-in for the real Code Agent. Deterministic catalogue lookup so
 * the loop (request → bundle → validate → bind) runs without a model.
 */
export class StubCodeAgent implements CodeAgent {
  readonly name = 'stub-agent';

  constructor(private readonly catalog: AssetSpec[] = ROOM_ITEMS) {}

  async createAsset(request: AssetRequest): Promise<AssetBundle> {
    const modifying = request.op === 'modify' && request.baseAsset;
    const base = modifying
      ? this.catalog.find((item) => item.assetId === request.baseAsset!.assetId)
      : undefined;
    const spec: AssetSpec = base
      ? { ...base, promptFragment: `${base.promptFragment}；${request.intent.text}` }
      : this.match(request.intent.text);
    const script = compileAssetScript(spec);
    return {
      assetId: spec.assetId,
      version: modifying ? bumpPatch(request.baseAsset!.version) : '1.0.0',
      semantic: spec.semantic,
      script: { source: script.source, hash: hashString(script.source) },
      appearance: {
        promptFragment: spec.promptFragment,
        refImages: [],
        palette: spec.palette,
        roughness: spec.roughness ?? 0.8,
        scaleHint: spec.scaleHint,
        styleTags: spec.styleTags,
      },
      physics: { mass: 0, friction: 0.8, restitution: 0, kind: 'static' },
      colliders: script.colliders,
      bounds: script.bounds,
      triCount: script.triCount,
      fitDependent: spec.fitDependent ?? false,
      provenance: {
        worldId: request.worldId,
        chunkId: request.chunkId,
        requestId: request.requestId,
        createdAt: new Date().toISOString(),
      },
    };
  }

  async createTerrainEdit(request: TerrainEditRequest): Promise<TerrainEditDraft> {
    return parseTerrainIntent(request);
  }

  private match(text: string): AssetSpec {
    const needle = text.trim();
    return (
      this.catalog.find((item) => item.semantic === needle) ??
      this.catalog.find(
        (item) => needle.includes(item.semantic) || item.semantic.includes(needle),
      ) ?? {
        assetId: 'generic_box',
        semantic: needle || '方块',
        promptFragment: `${needle || '方块'}，中性灰哑光材质，边缘轻微倒角`,
        parts: [box([1, 1, 1], [0, 0.5, 0], '#8d8d8d')],
        palette: ['#8d8d8d'],
        scaleHint: 'human',
        styleTags: ['prototype'],
      }
    );
  }
}

/** 1.0.0 → 1.0.1; used by the modify flow to keep versions immutable. */
function bumpPatch(version: string): string {
  const parts = version.split('.').map(Number);
  return `${parts[0] ?? 1}.${parts[1] ?? 0}.${(parts[2] ?? 0) + 1}`;
}

/** Shared Chinese intent parsing for the stub (no model involved). */
function parseTerrainIntent(request: TerrainEditRequest): TerrainEditDraft {
  const text = request.intent.text;
  const centre = request.target.kind === 'point' ? request.target.pos : { x: 0, y: 0, z: 0 };
  const radius =
    request.target.kind === 'point'
      ? Math.min(
          request.constraints.maxRadiusM,
          Math.max(1.5, request.target.footprintRadiusM || 2.5),
        )
      : 3;
  const amount = Number(
    text.match(/([\d.]+)\s*(?:米|m|公分)/)?.[1] ?? text.match(/([\d.]+)/)?.[1] ?? 0.5,
  );

  if (/铺|换成|石板|地毯|草地|材质/.test(text)) {
    const material = /草/.test(text) ? 'grass' : /地毯|毯/.test(text) ? 'floor' : 'road';
    return {
      op: 'paint',
      shape: { kind: 'disc', center: centre, radius },
      strength: 1,
      material,
      reason: `paint ${material}`,
    };
  }
  if (/压低|下沉|降低|挖/.test(text)) {
    return {
      op: 'lower',
      shape: { kind: 'disc', center: centre, radius },
      strength: amount,
      reason: 'lower',
    };
  }
  if (/抬高|升高|垫高|堆/.test(text)) {
    return {
      op: 'raise',
      shape: { kind: 'disc', center: centre, radius },
      strength: amount,
      reason: 'raise',
    };
  }
  const targetHeight = Number(text.match(/(?:到|至)\s*([\d.-]+)\s*(?:米|m)?/)?.[1] ?? centre.y);
  return {
    op: 'flatten',
    shape: { kind: 'disc', center: { ...centre, y: targetHeight }, radius },
    strength: 1,
    reason: 'flatten',
  };
}

/** Direct OpenAI-compatible endpoint. Used by the CLI when keys are present. */
export class OpenAITransport implements ChatTransport {
  readonly name = 'openai';

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async chat(messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatMessage> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages,
        ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw new Error(`agent http ${response.status}: ${await response.text()}`);
    const payload = (await response.json()) as { choices: { message: ChatMessage }[] };
    const message = payload.choices[0]?.message;
    if (!message) throw new Error('agent returned no message');
    return message;
  }
}

/**
 * Forwards chat calls to the video service, which holds the API key.
 * Keeps secrets on the server while tools still run in the browser.
 */
export class ProxyTransport implements ChatTransport {
  readonly name = 'proxy';

  constructor(private readonly serviceUrl: string) {}

  async chat(messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatMessage> {
    const response = await fetch(`${this.serviceUrl.replace(/\/$/, '')}/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages, tools }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw new Error(`agent proxy ${response.status}: ${await response.text()}`);
    const payload = (await response.json()) as { message: ChatMessage };
    return payload.message;
  }
}

/** Prompt given to the model. Keep it short; the request carries the context. */
export function buildAgentSystemPrompt(): string {
  return [
    'You are the asset author for Chrona, a 3D sandbox.',
    'Return exactly one JSON object, no markdown.',
    'AssetBundle fields: assetId, version ("1.0.0"), semantic (short Chinese noun),',
    'script.source (a JS function BODY with signature (THREE, RAPIER, ctx) returning',
    '{ object3d, colliders, bounds, triCount }), appearance { promptFragment (<=80 chars,',
    'materials only), refImages [], palette (hex[]), roughness, scaleHint, styleTags },',
    'and fitDependent (true for stairs/ramps/bridges).',
    'Units are metres, Y is up, asset local origin sits on the ground.',
    'Prefer boxes/cylinders; keep under 64k triangles and under 24 assets per chunk.',
    'You may call tools: scene_snapshot, terrain_sample, asset_validate, asset_write, terrain_commit.',
    'Always call asset_validate before asset_write.',
  ].join(' ');
}

/** Extract a JSON object from a model reply that may be wrapped in prose/fences. */
export function parseJsonReply(content: string | null): Record<string, unknown> {
  if (!content) throw new Error('empty agent reply');
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : content;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('agent reply has no JSON object');
  return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
}

/**
 * Tool-calling agent. The loop is local: the model asks for a tool, we run it
 * here, and feed the result back until it returns the final bundle.
 */
export class ApiCodeAgent implements CodeAgent {
  readonly name = 'api-agent';

  constructor(
    private readonly transport: ChatTransport,
    private readonly tools: ToolHost,
    private readonly maxTurns = 8,
  ) {}

  async createAsset(request: AssetRequest): Promise<AssetBundle> {
    const messages: ChatMessage[] = [
      { role: 'system', content: buildAgentSystemPrompt() },
      {
        role: 'user',
        content: JSON.stringify({
          op: request.op,
          intent: request.intent,
          target: request.target,
          scene: request.scene,
          baseAsset: request.baseAsset,
          budget: request.budget,
          constraints: request.constraints,
        }),
      },
    ];

    for (let turn = 0; turn < this.maxTurns; turn += 1) {
      const reply = await this.transport.chat(messages, this.tools.specs);
      messages.push(reply);

      if (!reply.tool_calls?.length) {
        return parseJsonReply(reply.content) as unknown as AssetBundle;
      }

      for (const call of reply.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        } catch {
          args = {};
        }
        let result: unknown;
        try {
          result = await this.tools.call(call.function.name, args);
        } catch (error) {
          result = { error: (error as Error).message };
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          content: JSON.stringify(result),
        });
      }
    }
    throw new Error(`agent exceeded ${this.maxTurns} tool turns`);
  }

  async createTerrainEdit(request: TerrainEditRequest): Promise<TerrainEditDraft> {
    const messages: ChatMessage[] = [
      { role: 'system', content: buildAgentSystemPrompt() },
      {
        role: 'user',
        content:
          'Return one JSON TerrainEditDraft {op, shape{kind,center,radius}, strength, material?, reason} for: ' +
          JSON.stringify({
            intent: request.intent,
            target: request.target,
            constraints: request.constraints,
          }),
      },
    ];
    const reply = await this.transport.chat(messages, []);
    return parseJsonReply(reply.content) as unknown as TerrainEditDraft;
  }
}
