// herdr の socket API (protocol 22) のうち、このプラグインが読むフィールドだけを型にしたもの。
// 正本は herdr リポジトリの docs/next/api/herdr-api.schema.json。

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface WorkspaceInfo {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  tab_count: number;
  pane_count: number;
  active_tab_id: string;
  agent_status: AgentStatus;
}

export interface TabInfo {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  agent_status: AgentStatus;
}

export interface AgentInfo {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  terminal_id: string;
  agent_status: AgentStatus;
  focused: boolean;
  revision: number;
  agent?: string | null;
  display_agent?: string | null;
  name?: string | null;
  title?: string | null;
  cwd?: string | null;
  /** working/blocked → idle の「完了」遷移が起きたときの state_change_seq。完了していなければ null */
  completion_seq?: number | null;
  state_change_seq?: number;
}

export interface SessionSnapshot {
  version: string;
  protocol: number;
  focused_workspace_id?: string | null;
  focused_tab_id?: string | null;
  focused_pane_id?: string | null;
  workspaces: WorkspaceInfo[];
  tabs: TabInfo[];
  agents: AgentInfo[];
}

/** ボタン1つ分 = herdr のタブ1つ分の表示状態 */
export type TabState = AgentStatus | "none";

export interface TabView {
  tabId: string;
  workspaceId: string;
  workspaceLabel: string;
  tabLabel: string;
  /** そのワークスペースにタブが複数あるか(読み上げ・表示でタブ名を添えるかの判断に使う) */
  multiTab: boolean;
  state: TabState;
  /** ボタンを押したときにフォーカスするペイン(確認待ち > 完了 > 作業中 の順で選ぶ) */
  attentionPaneId: string | null;
  agentLabel: string | null;
  agentCount: number;
  focused: boolean;
}

/** done = 完了 / blocked = 確認待ち / status = 長押しで「いまどうなってる？」と聞いたとき */
export type NarrationKind = "done" | "blocked" | "status";

export interface NarrationEvent {
  kind: NarrationKind;
  paneId: string;
  tabId: string;
  workspaceId: string;
  workspaceLabel: string;
  tabLabel: string;
  multiTab: boolean;
  agentLabel: string;
  focused: boolean;
  /** status のときの現在の状態 */
  state?: AgentStatus;
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
