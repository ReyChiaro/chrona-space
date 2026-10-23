import type {
  AssetBundle,
  AssetRequest,
  TerrainEditDraft,
  TerrainEditRequest,
} from '@chrona/protocol';
import { hashString } from '@chrona/world';
import { box, compileAssetScript, type AssetSpec } from './assetScript.js';
import { ROOM_ITEMS } from './room.js';

export interface CodeAgent {
  readonly name: string;
  createAsset(request: AssetRequest): Promise<AssetBundle>;
  createTerrainEdit(request: TerrainEditRequest): Promise<TerrainEditDraft>;
}

/**
 * Offline stand-in for the real Code Agent. It maps intent text onto a fixed
 * catalogue of primitives so the whole loop (request → bundle → validate →
 * bind) runs without a model. The API-backed agent returns the same shape.
 */
export class StubCodeAgent implements CodeAgent {
  readonly name = 'stub-agent';

  constructor(private readonly catalog: AssetSpec[] = ROOM_ITEMS) {}

  async createAsset(request: AssetRequest): Promise<AssetBundle> {
    const spec = this.match(request.intent.text);
    const script = compileAssetScript(spec);
    return {
      assetId: spec.assetId,
      version: '1.0.0',
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
    const text = request.intent.text;
    const centre =
      request.target.kind === 'point'
        ? request.target.pos
        : { x: 0, y: 0, z: 0 };
    const radius =
      request.target.kind === 'point'
        ? Math.min(request.constraints.maxRadiusM, Math.max(1.5, request.target.footprintRadiusM || 2.5))
        : 3;

    const amount = Number(text.match(/([\d.]+)\s*(?:米|m|公分)/)?.[1] ?? text.match(/([\d.]+)/)?.[1] ?? 0.5);

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
      return { op: 'lower', shape: { kind: 'disc', center: centre, radius }, strength: amount, reason: 'lower' };
    }
    if (/抬高|升高|垫高|堆/.test(text)) {
      return { op: 'raise', shape: { kind: 'disc', center: centre, radius }, strength: amount, reason: 'raise' };
    }
    const targetHeight = Number(text.match(/(?:到|至)\s*([\d.-]+)\s*(?:米|m)?/)?.[1] ?? centre.y);
    return {
      op: 'flatten',
      shape: { kind: 'disc', center: { ...centre, y: targetHeight }, radius },
      strength: 1,
      reason: 'flatten',
    };
  }

  private match(text: string): AssetSpec {
    const needle = text.trim();
    return (
      this.catalog.find((item) => item.semantic === needle) ??
      this.catalog.find((item) => needle.includes(item.semantic) || item.semantic.includes(needle)) ?? {
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

/**
 * Real Code Agent adapter. Disabled by default; enabling it requires
 * CHRONA_AGENT_BASE_URL / CHRONA_AGENT_API_KEY in .env.
 */
export class ApiCodeAgent implements CodeAgent {
  readonly name = 'api-agent';

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async createAsset(request: AssetRequest): Promise<AssetBundle> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: 'Return one JSON AssetBundle. See skills/asset-contract.md.' },
          { role: 'user', content: JSON.stringify(request) },
        ],
        response_format: { type: 'json_object' },
      }),
    });
    if (!response.ok) throw new Error(`code agent failed: ${response.status}`);
    const payload = (await response.json()) as { choices: { message: { content: string } }[] };
    return JSON.parse(payload.choices[0].message.content) as AssetBundle;
  }

  async createTerrainEdit(request: TerrainEditRequest): Promise<TerrainEditDraft> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: 'Return one JSON TerrainEditDraft. See skills/terrain-edit.md.' },
          { role: 'user', content: JSON.stringify(request) },
        ],
        response_format: { type: 'json_object' },
      }),
    });
    if (!response.ok) throw new Error(`code agent failed: ${response.status}`);
    const payload = (await response.json()) as { choices: { message: { content: string } }[] };
    return JSON.parse(payload.choices[0].message.content) as TerrainEditDraft;
  }
}
