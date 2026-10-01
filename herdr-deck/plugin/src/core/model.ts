import type { AgentInfo, AgentStatus, NarrationEvent, SessionSnapshot, TabState, TabView } from "./types.ts";

// herdr 本体のタブ集約 (tab_attention_priority) と同じ優先度: 確認待ち > 完了 > 作業中 > 待機 > 不明
const PRIORITY: Record<AgentStatus, number> = { blocked: 4, done: 3, working: 2, idle: 1, unknown: 0 };

export function agentLabel(agent: AgentInfo): string {
  return agent.name || agent.display_agent || agent.agent || "agent";
}

/**
 * スナップショットを「ボタンに並べる順」のタブ一覧にする。
 * 並びは herdr のサイドバーと同じ (ワークスペース順 → タブ順)。
 */
export function buildTabViews(snapshot: SessionSnapshot, filter: "all" | "agents" = "all"): TabView[] {
  const wsById = new Map(snapshot.workspaces.map((w) => [w.workspace_id, w]));
  const wsOrder = new Map(snapshot.workspaces.map((w, i) => [w.workspace_id, i]));
  const agentsByTab = new Map<string, AgentInfo[]>();
  for (const a of snapshot.agents) {
    const list = agentsByTab.get(a.tab_id) ?? [];
    list.push(a);
    agentsByTab.set(a.tab_id, list);
  }
  const tabsPerWs = new Map<string, number>();
  for (const t of snapshot.tabs) tabsPerWs.set(t.workspace_id, (tabsPerWs.get(t.workspace_id) ?? 0) + 1);

  // tabs はワークスペース順に並んで返ってくるが、念のため安定ソートでワークスペース順を保証する
  const tabs = snapshot.tabs
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (wsOrder.get(a.t.workspace_id) ?? 0) - (wsOrder.get(b.t.workspace_id) ?? 0) || a.i - b.i)
    .map(({ t }) => t);

  const views: TabView[] = [];
  for (const tab of tabs) {
    const agents = agentsByTab.get(tab.tab_id) ?? [];
    if (filter === "agents" && agents.length === 0) continue;
    const top = pickAttention(agents);
    const state: TabState = top ? top.agent_status : "none";
    const ws = wsById.get(tab.workspace_id);
    views.push({
      tabId: tab.tab_id,
      workspaceId: tab.workspace_id,
      workspaceLabel: ws?.label || tab.workspace_id,
      tabLabel: tab.label || String(tab.number),
      multiTab: (tabsPerWs.get(tab.workspace_id) ?? 1) > 1,
      state,
      attentionPaneId: top?.pane_id ?? null,
      agentLabel: top ? agentLabel(top) : null,
      agentCount: agents.length,
      focused: tab.focused,
    });
  }
  return views;
}

function pickAttention(agents: AgentInfo[]): AgentInfo | null {
  let best: AgentInfo | null = null;
  for (const a of agents) {
    if (!best || PRIORITY[a.agent_status] > PRIORITY[best.agent_status]) best = a;
  }
  return best;
}

interface Seen {
  status: AgentStatus;
  completionSeq: number | null;
  stateChangeSeq: number | null;
}

/**
 * スナップショットの差分から「読み上げるべき出来事」を取り出す。
 *
 * - 完了: herdr が working/blocked → idle の遷移で発行する completion_seq が新しくなったとき。
 *   1.2秒の間に working → idle → working と動いても取りこぼさない。
 * - 確認待ち: blocked に入ったとき (state_change_seq が変わったときも含む)。
 *
 * 最初のスナップショットは「現状把握」だけで読み上げない (起動直後に全タブがしゃべり出さないように)。
 */
export class EventDetector {
  #seen = new Map<string, Seen>();
  #primed = false;
  #lastSpoken = new Map<string, number>();
  #cooldownMs: number;
  #now: () => number;

  constructor(opts: { cooldownMs?: number; now?: () => number } = {}) {
    this.#cooldownMs = opts.cooldownMs ?? 8000;
    this.#now = opts.now ?? Date.now;
  }

  set cooldownMs(ms: number) {
    this.#cooldownMs = ms;
  }

  update(snapshot: SessionSnapshot): NarrationEvent[] {
    const events: NarrationEvent[] = [];
    const wsById = new Map(snapshot.workspaces.map((w) => [w.workspace_id, w]));
    const tabById = new Map(snapshot.tabs.map((t) => [t.tab_id, t]));
    const tabsPerWs = new Map<string, number>();
    for (const t of snapshot.tabs) tabsPerWs.set(t.workspace_id, (tabsPerWs.get(t.workspace_id) ?? 0) + 1);
    const alive = new Set<string>();

    for (const a of snapshot.agents) {
      alive.add(a.pane_id);
      const prev = this.#seen.get(a.pane_id);
      const cur: Seen = {
        status: a.agent_status,
        completionSeq: a.completion_seq ?? null,
        stateChangeSeq: a.state_change_seq ?? null,
      };
      this.#seen.set(a.pane_id, cur);
      if (!this.#primed) continue;

      let kind: "done" | "blocked" | null = null;
      if (cur.status === "blocked") {
        if (!prev || prev.status !== "blocked" || (cur.stateChangeSeq !== null && cur.stateChangeSeq !== prev.stateChangeSeq)) {
          kind = "blocked";
        }
      } else if (prev && cur.completionSeq !== null && cur.completionSeq !== prev.completionSeq) {
        // もう次の作業に入っている(working)なら、終わった報告は要らない
        if (cur.status === "done" || cur.status === "idle") kind = "done";
      }
      if (!kind) continue;

      const key = `${a.pane_id}:${kind}`;
      const now = this.#now();
      const last = this.#lastSpoken.get(key);
      if (last !== undefined && now - last < this.#cooldownMs) continue;
      this.#lastSpoken.set(key, now);

      const tab = tabById.get(a.tab_id);
      events.push({
        kind,
        paneId: a.pane_id,
        tabId: a.tab_id,
        workspaceId: a.workspace_id,
        workspaceLabel: wsById.get(a.workspace_id)?.label || a.workspace_id,
        tabLabel: tab?.label || a.tab_id,
        multiTab: (tabsPerWs.get(a.workspace_id) ?? 1) > 1,
        agentLabel: agentLabel(a),
        focused: a.focused,
      });
    }

    for (const id of [...this.#seen.keys()]) {
      if (!alive.has(id)) this.#seen.delete(id);
    }
    this.#primed = true;
    return events;
  }

  /** herdr サーバーが再起動したときなど、状態を捨てて取り直す */
  reset(): void {
    this.#seen.clear();
    this.#primed = false;
  }
}

/** 状態ごとの日本語ラベル (ボタンと CLI 表示で共通) */
export const STATE_LABEL: Record<TabState, string> = {
  working: "作業中",
  blocked: "確認待ち",
  done: "完了",
  idle: "待機",
  unknown: "不明",
  none: "─",
};
