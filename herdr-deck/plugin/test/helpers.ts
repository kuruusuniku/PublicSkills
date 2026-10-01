import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentInfo, AgentStatus, SessionSnapshot } from "../src/core/types.ts";

export interface TabSpec {
  label: string;
  agents?: { status: AgentStatus; completion?: number | null; seq?: number; agent?: string; focused?: boolean }[];
  focused?: boolean;
}

export interface WorkspaceSpec {
  label: string;
  tabs: TabSpec[];
}

/** herdr api snapshot の result.snapshot を、schema の必須フィールド込みで組み立てる */
export function makeSnapshot(workspaces: WorkspaceSpec[], version = "0.9.3"): SessionSnapshot {
  const snap: SessionSnapshot = { version, protocol: 22, workspaces: [], tabs: [], agents: [] };
  workspaces.forEach((ws, wi) => {
    const wid = `w${wi + 1}`;
    let paneNo = 0;
    const tabStatuses: AgentStatus[] = [];
    ws.tabs.forEach((tab, ti) => {
      const tid = `${wid}:t${ti + 1}`;
      const agents: AgentInfo[] = (tab.agents ?? []).map((a) => {
        paneNo++;
        return {
          pane_id: `${wid}:p${paneNo}`,
          tab_id: tid,
          workspace_id: wid,
          terminal_id: `term-${wid}-${paneNo}`,
          agent_status: a.status,
          focused: !!a.focused,
          revision: 1,
          agent: a.agent ?? "claude",
          display_agent: null,
          name: null,
          completion_seq: a.completion ?? null,
          state_change_seq: a.seq ?? 1,
        };
      });
      if (agents.length === 0) paneNo++;
      snap.agents.push(...agents);
      const st = agents[0]?.agent_status ?? "unknown";
      tabStatuses.push(st);
      snap.tabs.push({
        tab_id: tid,
        workspace_id: wid,
        number: ti + 1,
        label: tab.label,
        focused: !!tab.focused,
        pane_count: Math.max(1, agents.length),
        agent_status: st,
      });
    });
    snap.workspaces.push({
      workspace_id: wid,
      number: wi + 1,
      label: ws.label,
      focused: wi === 0,
      tab_count: ws.tabs.length,
      pane_count: paneNo,
      active_tab_id: `${wid}:t1`,
      agent_status: tabStatuses[0] ?? "unknown",
    });
  });
  return snap;
}

export interface MockServer {
  url: string;
  requests: { method: string; path: string; body: string }[];
  close(): Promise<void>;
}

/** テスト用の HTTP サーバー (OpenAI 互換 LLM / VOICEVOX のふり) */
export async function mockServer(
  handler: (req: IncomingMessage, body: string, res: ServerResponse) => void | Promise<void>,
): Promise<MockServer> {
  const requests: MockServer["requests"] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ method: req.method ?? "", path: req.url ?? "", body });
      Promise.resolve(handler(req, body, res)).catch((err) => {
        res.statusCode = 500;
        res.end(String(err));
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** 最小の WAV (無音 10ms) */
export function tinyWav(): Buffer {
  const samples = 160;
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** VOICEVOX ENGINE のふりをするサーバー */
export function voicevoxHandler(opts: { fail?: boolean } = {}) {
  return (req: IncomingMessage, _body: string, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (opts.fail) {
      res.statusCode = 500;
      res.end("engine error");
      return;
    }
    if (url.pathname === "/audio_query") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ accent_phrases: [], speedScale: 1, pitchScale: 0, intonationScale: 1, volumeScale: 1, text: url.searchParams.get("text") }));
    } else if (url.pathname === "/synthesis") {
      res.setHeader("content-type", "audio/wav");
      res.end(tinyWav());
    } else if (url.pathname === "/speakers") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([{ name: "ずんだもん", styles: [{ name: "ノーマル", id: 3 }, { name: "あまあま", id: 1 }] }]));
    } else {
      res.statusCode = 404;
      res.end();
    }
  };
}

/** OpenAI 互換 /chat/completions のふりをするサーバー */
export function llmHandler(reply: string, models = ["gemma3:4b"]) {
  return (req: IncomingMessage, _body: string, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    res.setHeader("content-type", "application/json");
    if (url.pathname.endsWith("/chat/completions")) {
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: reply } }] }));
    } else if (url.pathname.endsWith("/models")) {
      res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  };
}
